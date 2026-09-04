const crypto = require("node:crypto");
const {
  HHAD_COMPANION_SHADOW_STRATEGY,
  HHAD_COMPANION_SHADOW_VERSION,
  STRATEGY_HASH,
  canonicalStringify,
  evaluateHhadCompanionShadow,
  normalizeProbabilityTriplet,
  settleHhadCompanionShadow,
} = require("./hhadCompanionShadow.cjs");

const HHAD_COMPANION_EVALUATION_VERSION = "hhad-companion-shadow-evaluation-v1";
const OUTCOME_CODES = ["1", "X", "2"];
const VOID_STATUSES = new Set(["VOID", "CANCELLED", "CANCELED", "ABANDONED"]);
const WINDOW_COUNT = 6;
const PROMOTION_SOURCE_TIME_KEYS = [
  "capturedAt",
  "receivedAt",
  "observedAt",
  "modelGeneratedAt",
  "unifiedPosteriorGeneratedAt",
  "decisionAt",
  "featureSnapshotCapturedAt",
];

const HHAD_COMPANION_CANDIDATE_GATE = Object.freeze({
  minimumPairedNonVoidRows: 500,
  windows: WINDOW_COUNT,
  minimumRowsPerWindow: 40,
  minimumImprovingWindows: 5,
  recentNonNegativeWindows: 2,
  minimumMatchDays: 30,
  bootstrapConfidence: 0.95,
  exactReplayRate: 1,
  requiredGlobalRiskTier: "stable",
  onlineEffect: "shadow",
});

const finiteNumber = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const rounded = (value, digits = 6) => {
  const numeric = finiteNumber(value);
  return numeric === null ? null : Number(numeric.toFixed(digits));
};

const canonicalInstant = (value) => {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
};

const canonicalDay = (value) => {
  const raw = String(value || "").trim();
  const direct = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (direct) return direct[1];
  const instant = canonicalInstant(value);
  return instant ? instant.slice(0, 10) : null;
};

const hashText = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

const mean = (values) => {
  const rows = values.filter((value) => Number.isFinite(value));
  return rows.length ? rows.reduce((sum, value) => sum + value, 0) / rows.length : null;
};

const quantile = (values, probability) => {
  const rows = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (!rows.length) return null;
  const index = Math.max(0, Math.min(rows.length - 1, Math.floor((rows.length - 1) * probability)));
  return rows[index];
};

const semanticProjection = (track) => ({
  strategy: track?.strategy || null,
  version: track?.version || null,
  action: track?.action || null,
  eligible: track?.eligible === true,
  blockers: Array.isArray(track?.blockers) ? track.blockers : [],
  matchKey: track?.matchKey || null,
  cutoffTime: track?.cutoffTime || null,
  sourceTimes: track?.sourceTimes || null,
  market: track?.market || null,
  model: track?.model || null,
  selection: track?.selection || null,
  diagnostics: track?.diagnostics || null,
  strategyHash: track?.strategyHash || null,
  cohortHash: track?.cohortHash || null,
  revisionHash: track?.revisionHash || null,
  exposureHash: track?.exposureHash || null,
  pairHash: track?.pairHash || null,
  hashes: track?.hashes || null,
});

const trackFromSnapshot = (snapshot) => snapshot?.decisionSnapshot?.exposure?.shadowTracks?.HHAD_COMPANION
  || snapshot?.exposure?.shadowTracks?.HHAD_COMPANION
  || snapshot?.shadowTracks?.HHAD_COMPANION
  || (snapshot?.strategy === HHAD_COMPANION_SHADOW_STRATEGY ? snapshot : null);

const sourceRevisionFromSnapshot = (snapshot) => {
  const decisionId = String(snapshot?.decisionId || "").trim();
  const revision = finiteNumber(snapshot?.decisionRevision);
  if (!decisionId && revision === null) return null;
  return `${decisionId || "decision"}:r${revision ?? "unknown"}`;
};

const replayHhadCompanionTrack = (track, snapshot = null) => {
  const provenance = track?.provenance || {};
  const sourceTimes = track?.sourceTimes || {};
  const best = track?.diagnostics?.best || null;
  const replayed = evaluateHhadCompanionShadow({
    sourceMatchId: track?.matchKey || snapshot?.sourceMatchId || null,
    matchId: snapshot?.matchId || null,
    cutoffTime: track?.cutoffTime,
    capturedAt: sourceTimes.capturedAt,
    receivedAt: sourceTimes.receivedAt,
    observedAt: sourceTimes.observedAt,
    modelGeneratedAt: sourceTimes.modelGeneratedAt,
    unifiedPosteriorGeneratedAt: sourceTimes.unifiedPosteriorGeneratedAt,
    decisionAt: sourceTimes.decisionAt,
    featureSnapshotCapturedAt: sourceTimes.featureSnapshotCapturedAt,
    sourceRevision: provenance.sourceRevision ?? sourceRevisionFromSnapshot(snapshot),
    sourceSnapshotHash: provenance.sourceSnapshotHash
      ?? snapshot?.featureSnapshotHash
      ?? snapshot?.featureSnapshot?.hash
      ?? null,
    modelVersion: provenance.modelVersion ?? snapshot?.modelVersion ?? null,
    handicapLine: track?.market?.officialHandicapLine,
    modelHandicapLine: track?.market?.modelHandicapLine,
    odds: track?.market?.odds,
    modelProbabilities: track?.model?.probabilities,
    best: best ? {
      poolCode: best.poolCode,
      code: best.code,
      handicapLine: best.handicapLine,
    } : null,
  });
  const identityExact = track?.strategy === HHAD_COMPANION_SHADOW_STRATEGY
    && track?.version === HHAD_COMPANION_SHADOW_VERSION
    && track?.strategyHash === STRATEGY_HASH;
  const publicBoundaryExact = track?.publicVisible === false;
  const semanticsExact = canonicalStringify(semanticProjection(track))
    === canonicalStringify(semanticProjection(replayed));
  const reasons = [];
  if (track?.strategy !== HHAD_COMPANION_SHADOW_STRATEGY) reasons.push("strategy-mismatch");
  if (track?.version !== HHAD_COMPANION_SHADOW_VERSION) reasons.push("version-mismatch");
  if (track?.strategyHash !== STRATEGY_HASH) reasons.push("strategy-hash-mismatch");
  if (!publicBoundaryExact) reasons.push("public-boundary-mismatch");
  if (!semanticsExact) reasons.push("semantic-replay-mismatch");
  return {
    exact: identityExact && publicBoundaryExact && semanticsExact,
    identityExact,
    publicBoundaryExact,
    semanticsExact,
    reasons,
    replayed,
  };
};

const decisionOrderValues = (entry) => [
  entry.track?.sourceTimes?.capturedAt,
  entry.track?.sourceTimes?.unifiedPosteriorGeneratedAt,
  entry.track?.sourceTimes?.modelGeneratedAt,
  entry.track?.sourceTimes?.observedAt,
].map((value) => canonicalInstant(value) || String(value || ""));

const decisionOrderKey = (entry) => decisionOrderValues(entry).join("|");

const entryOrder = (entry) => [
  ...decisionOrderValues(entry),
  entry.track?.exposureHash || "",
].join("|");

const compareEntries = (left, right) => entryOrder(left).localeCompare(entryOrder(right));

const snapshotKickoff = (snapshot) => snapshot?.kickoffTime
  || snapshot?.decisionSnapshot?.kickoffTime
  || null;

const eventVersionForSnapshot = (snapshot) => canonicalInstant(snapshotKickoff(snapshot));

const snapshotMatchDay = (snapshot, result = null) => canonicalDay(
  snapshot?.businessDate
  || result?.businessDate
  || snapshotKickoff(snapshot)
  || result?.kickoffTime
);

const isCapturedBeforeDeadline = (entry) => {
  const capturedMs = Date.parse(entry.track?.sourceTimes?.capturedAt || "");
  const cutoffMs = Date.parse(entry.track?.cutoffTime || "");
  const kickoffMs = Date.parse(snapshotKickoff(entry.snapshot) || "");
  if (!Number.isFinite(capturedMs) || !Number.isFinite(cutoffMs)) return false;
  const deadlineMs = Number.isFinite(kickoffMs) ? Math.min(cutoffMs, kickoffMs) : cutoffMs;
  return capturedMs <= deadlineMs;
};

const promotionSourceTimeAudit = (entry) => {
  const cutoffMs = Date.parse(entry.track?.cutoffTime || "");
  const kickoffMs = Date.parse(snapshotKickoff(entry.snapshot) || "");
  const reasons = [];
  if (!Number.isFinite(cutoffMs)) reasons.push("missing-or-invalid-cutoff-time");
  if (!Number.isFinite(kickoffMs)) reasons.push("missing-or-invalid-kickoff-time");
  const deadlineMs = Number.isFinite(cutoffMs) && Number.isFinite(kickoffMs)
    ? Math.min(cutoffMs, kickoffMs)
    : null;
  for (const key of PROMOTION_SOURCE_TIME_KEYS) {
    const raw = entry.track?.sourceTimes?.[key];
    const instant = canonicalInstant(raw);
    if (!instant) {
      reasons.push(`missing-or-invalid-${key}`);
      continue;
    }
    if (deadlineMs !== null && Date.parse(instant) > deadlineMs) reasons.push(`${key}-after-event-deadline`);
  }
  return {
    eligible: reasons.length === 0,
    deadline: deadlineMs === null ? null : new Date(deadlineMs).toISOString(),
    reasons,
  };
};

const collectFinalHhadCompanionRevisions = (predictionSnapshots = []) => {
  const rawEntries = [];
  const counts = {
    snapshotRows: Array.isArray(predictionSnapshots) ? predictionSnapshots.length : 0,
    trackRows: 0,
    currentStrategyRows: 0,
    rejectedStrategyRows: 0,
    missingMatchKeyRows: 0,
    missingEventVersionRows: 0,
    missingRevisionHashRows: 0,
    duplicateRevisionRows: 0,
    conflictingDuplicateRows: 0,
    deadlineEligibleRows: 0,
    postCutoffOrUnorderableRows: 0,
    ambiguousFinalGroups: 0,
  };

  for (const snapshot of Array.isArray(predictionSnapshots) ? predictionSnapshots : []) {
    const track = trackFromSnapshot(snapshot);
    if (!track) continue;
    counts.trackRows += 1;
    if (track.strategyHash !== STRATEGY_HASH || track.strategy !== HHAD_COMPANION_SHADOW_STRATEGY) {
      counts.rejectedStrategyRows += 1;
      continue;
    }
    counts.currentStrategyRows += 1;
    if (!track.matchKey) {
      counts.missingMatchKeyRows += 1;
      continue;
    }
    if (!track.revisionHash) counts.missingRevisionHashRows += 1;
    const eventVersion = eventVersionForSnapshot(snapshot);
    if (!eventVersion) counts.missingEventVersionRows += 1;
    rawEntries.push({
      track,
      snapshot,
      eventVersion,
      replay: replayHhadCompanionTrack(track, snapshot),
      duplicateConflict: false,
    });
  }

  const deduplicated = new Map();
  for (const entry of rawEntries) {
    const revisionIdentity = entry.track.revisionHash || `missing:${hashText(canonicalStringify(entry.track))}`;
    const key = `${entry.track.matchKey}|${entry.track.strategyHash}|${entry.eventVersion || "missing-event"}|${revisionIdentity}`;
    const existing = deduplicated.get(key);
    if (!existing) {
      deduplicated.set(key, entry);
      continue;
    }
    counts.duplicateRevisionRows += 1;
    const conflict = canonicalStringify(semanticProjection(existing.track))
      !== canonicalStringify(semanticProjection(entry.track));
    const chosen = [existing, entry]
      .sort((left, right) => canonicalStringify(left.track).localeCompare(canonicalStringify(right.track)))[0];
    chosen.duplicateConflict = existing.duplicateConflict || entry.duplicateConflict || conflict;
    if (conflict) counts.conflictingDuplicateRows += 1;
    deduplicated.set(key, chosen);
  }

  const byGroup = new Map();
  for (const entry of deduplicated.values()) {
    if (!isCapturedBeforeDeadline(entry)) {
      counts.postCutoffOrUnorderableRows += 1;
      continue;
    }
    counts.deadlineEligibleRows += 1;
    const key = `${entry.track.matchKey}|${entry.track.strategyHash}|${entry.eventVersion || "missing-event"}`;
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(entry);
  }

  const finalEntries = [];
  for (const entries of byGroup.values()) {
    entries.sort(compareEntries);
    const latestOrderKey = decisionOrderKey(entries[entries.length - 1]);
    const tied = entries.filter((entry) => decisionOrderKey(entry) === latestOrderKey);
    const identities = new Set(tied.map((entry) => `${entry.track.revisionHash || ""}|${entry.track.exposureHash || ""}`));
    const ambiguous = identities.size > 1;
    if (ambiguous) counts.ambiguousFinalGroups += 1;
    tied.sort((left, right) => String(left.track.exposureHash || "").localeCompare(String(right.track.exposureHash || "")));
    const selected = tied[tied.length - 1];
    selected.ambiguous = ambiguous;
    selected.ambiguousRevisionHashes = ambiguous
      ? tied.map((entry) => entry.track.revisionHash || null).sort()
      : [];
    selected.ambiguousExposureHashes = ambiguous
      ? tied.map((entry) => entry.track.exposureHash || null).sort()
      : [];
    finalEntries.push(selected);
  }
  finalEntries.sort((left, right) => (
    String(left.track.matchKey).localeCompare(String(right.track.matchKey))
    || compareEntries(left, right)
  ));

  return { finalEntries, counts };
};

const resultKeys = (result) => Array.from(new Set([
  result?.sourceMatchId,
  result?.matchKey,
  result?.matchId,
  String(result?.matchId || "").replace(/^sporttery_/, ""),
].map((value) => String(value || "").trim()).filter(Boolean)));

const officialResult = (result) => Boolean(
  (() => {
    const explicitResultSource = String(result?.resultSource || "").trim();
    if (explicitResultSource && !/^sporttery(?::|$)/i.test(explicitResultSource)) return false;
    return result?.official === true
      || String(result?.sourceUrl || "").includes("webapi.sporttery.cn")
      || /^sporttery(?::|$)/i.test(explicitResultSource);
  })()
);

const resultStatus = (result) => String(result?.status || result?.matchStatus || "").trim().toUpperCase();

const validOfficialResult = (result) => {
  if (!officialResult(result)) return false;
  const status = resultStatus(result);
  if (VOID_STATUSES.has(status) || result?.voided === true) return true;
  const home = finiteNumber(result?.scoreHome ?? result?.home);
  const away = finiteNumber(result?.scoreAway ?? result?.away);
  return status === "FINISHED"
    && Number.isInteger(home)
    && Number.isInteger(away)
    && home >= 0
    && away >= 0;
};

const buildOfficialResultIndex = (results = []) => {
  const index = new Map();
  const counts = { resultRows: 0, officialRows: 0, rejectedNonOfficialOrInvalidRows: 0 };
  for (const result of Array.isArray(results) ? results : []) {
    counts.resultRows += 1;
    if (!validOfficialResult(result)) {
      counts.rejectedNonOfficialOrInvalidRows += 1;
      continue;
    }
    counts.officialRows += 1;
    for (const key of resultKeys(result)) {
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(result);
    }
  }
  return { index, counts };
};

const resultOutcomeIdentity = (result) => [
  resultStatus(result),
  finiteNumber(result?.scoreHome ?? result?.home),
  finiteNumber(result?.scoreAway ?? result?.away),
  result?.voided === true,
].join("|");

const resultTimeForEntry = (result, entry) => {
  const provenance = result?.resultProvenance && typeof result.resultProvenance === "object"
    ? result.resultProvenance
    : null;
  const observedRaw = provenance?.observedAt ?? result?.resultObservedAt;
  const observedAt = canonicalInstant(observedRaw);
  const observationSource = String(
    provenance?.observationSource ?? result?.resultObservationSource ?? ""
  ).trim() || null;
  const sourceUpdatedAt = canonicalInstant(
    provenance?.sourceUpdatedAt ?? result?.resultSourceUpdatedAt
  );
  const fallback = provenance?.resultObservationFallback === true
    || result?.resultObservationFallback === true;
  const base = {
    observedAt,
    observationSource,
    sourceUpdatedAt,
    fallback,
    promotionEligible: false,
    // Compatibility alias for existing private audit readers. It now carries
    // only the real observation instant and is never synthesized.
    effectiveResultUpdatedAt: observedAt,
  };
  if (!observedAt) return { ...base, eligible: false, reason: "result-observed-at-missing-or-invalid" };
  if (!observationSource) return { ...base, eligible: false, reason: "result-observation-source-missing" };
  if (fallback) return { ...base, eligible: false, reason: "result-observation-fallback" };
  const kickoffMs = Date.parse(canonicalInstant(result?.kickoffTime) || entry.eventVersion || "");
  if (!Number.isFinite(kickoffMs) || Date.parse(observedAt) < kickoffMs) {
    return { ...base, eligible: false, reason: "result-observed-before-kickoff-or-event-missing" };
  }
  const cutoffMs = Date.parse(entry.track?.cutoffTime || "");
  if (!Number.isFinite(cutoffMs) || Date.parse(observedAt) <= cutoffMs) {
    return { ...base, eligible: false, reason: "result-time-not-after-cutoff" };
  }
  return { ...base, eligible: true, reason: null, promotionEligible: true };
};

const findOfficialResult = (entry, resultIndex) => {
  const keys = new Set([
    entry.track.matchKey,
    entry.snapshot?.sourceMatchId,
    entry.snapshot?.matchId,
    String(entry.snapshot?.matchId || "").replace(/^sporttery_/, ""),
  ].map((value) => String(value || "").trim()).filter(Boolean));
  const candidates = new Map();
  for (const key of keys) {
    for (const result of resultIndex.get(key) || []) candidates.set(canonicalStringify(result), result);
  }
  const byCanonicalRow = new Map();
  let eventMismatches = 0;
  let timeRejected = 0;
  for (const [canonicalRow, result] of candidates) {
    const resultEventVersion = canonicalInstant(result?.kickoffTime);
    if (resultEventVersion && resultEventVersion !== entry.eventVersion) {
      eventMismatches += 1;
      continue;
    }
    const time = resultTimeForEntry(result, entry);
    if (!time.eligible) {
      timeRejected += 1;
      continue;
    }
    byCanonicalRow.set(canonicalRow, { result, time });
  }
  const rows = Array.from(byCanonicalRow.values());
  if (!rows.length) return { result: null, conflict: false, eventMismatches, timeRejected };
  const outcomes = new Set(rows.map((row) => resultOutcomeIdentity(row.result)));
  if (outcomes.size > 1) return { result: null, conflict: true, eventMismatches, timeRejected };
  rows.sort((left, right) => {
    const leftTime = left.time.observedAt || "";
    const rightTime = right.time.observedAt || "";
    return rightTime.localeCompare(leftTime)
      || canonicalStringify(left.result).localeCompare(canonicalStringify(right.result));
  });
  return {
    result: rows[0].result,
    resultTime: rows[0].time,
    conflict: false,
    eventMismatches,
    timeRejected,
  };
};

const multiclassScores = (probabilities, actualCode) => {
  const normalized = normalizeProbabilityTriplet(probabilities);
  if (!normalized || !OUTCOME_CODES.includes(actualCode)) return null;
  const brier = OUTCOME_CODES.reduce((sum, code) => (
    sum + (normalized[code] - (code === actualCode ? 1 : 0)) ** 2
  ), 0);
  const logLoss = -Math.log(Math.max(1e-15, normalized[actualCode]));
  return { probabilities: normalized, brier, logLoss };
};

const pairedMetrics = (rows) => {
  const modelBrier = mean(rows.map((row) => row.modelBrier));
  const marketBrier = mean(rows.map((row) => row.marketBrier));
  const modelLogLoss = mean(rows.map((row) => row.modelLogLoss));
  const marketLogLoss = mean(rows.map((row) => row.marketLogLoss));
  return {
    rows: rows.length,
    model: {
      brier: rounded(modelBrier),
      logLoss: rounded(modelLogLoss),
    },
    deviggedMarket: {
      brier: rounded(marketBrier),
      logLoss: rounded(marketLogLoss),
    },
    improvement: {
      brier: modelBrier === null || marketBrier === null ? null : rounded(marketBrier - modelBrier),
      logLoss: modelLogLoss === null || marketLogLoss === null ? null : rounded(marketLogLoss - modelLogLoss),
    },
    interpretation: "positive improvement means the HHAD companion model beats the same-exposure devigged market",
  };
};

const rowsByMatchDay = (rows) => {
  const byDay = new Map();
  for (const row of rows) {
    if (!row.matchDay) continue;
    if (!byDay.has(row.matchDay)) byDay.set(row.matchDay, []);
    byDay.get(row.matchDay).push(row);
  }
  return Array.from(byDay.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([day, dayRows]) => ({
      day,
      rows: dayRows.slice().sort((left, right) => String(left.exposureHash).localeCompare(String(right.exposureHash))),
    }));
};

const nonOverlappingWindows = (rows, count = WINDOW_COUNT) => {
  const days = rowsByMatchDay(rows);
  return Array.from({ length: count }, (_, index) => {
    const start = Math.floor((index * days.length) / count);
    const end = Math.floor(((index + 1) * days.length) / count);
    const groups = days.slice(start, end);
    const windowRows = groups.flatMap((group) => group.rows);
    return {
      index: index + 1,
      startMatchDay: groups[0]?.day || null,
      endMatchDay: groups.at(-1)?.day || null,
      matchDays: groups.length,
      ...pairedMetrics(windowRows),
    };
  });
};

const seededRandom = (seedText) => {
  let state = Number.parseInt(hashText(seedText).slice(0, 8), 16) >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

const blockBootstrap = (rows, requestedIterations = 2000) => {
  const days = rowsByMatchDay(rows);
  const iterations = Math.max(200, Math.min(10000, Math.floor(Number(requestedIterations) || 2000)));
  const seedMaterial = days.map((group) => [
    group.day,
    group.rows.map((row) => `${row.exposureHash}:${row.brierImprovement}:${row.logLossImprovement}`).join(","),
  ].join("|")).join("\n");
  const seed = hashText(seedMaterial);
  if (!days.length) {
    return {
      method: "deterministic-match-day-block-one-sided-percentile",
      confidence: HHAD_COMPANION_CANDIDATE_GATE.bootstrapConfidence,
      iterations,
      seed,
      matchDays: 0,
      rows: 0,
      percentileLowerProbability: rounded(1 - HHAD_COMPANION_CANDIDATE_GATE.bootstrapConfidence, 4),
      lowerBounds: { brierImprovement: null, logLossImprovement: null },
    };
  }
  const random = seededRandom(seed);
  const brierImprovements = [];
  const logLossImprovements = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sampled = [];
    for (let block = 0; block < days.length; block += 1) {
      const selected = days[Math.floor(random() * days.length)];
      sampled.push(...selected.rows);
    }
    brierImprovements.push(mean(sampled.map((row) => row.brierImprovement)));
    logLossImprovements.push(mean(sampled.map((row) => row.logLossImprovement)));
  }
  const lowerProbability = 1 - HHAD_COMPANION_CANDIDATE_GATE.bootstrapConfidence;
  return {
    method: "deterministic-match-day-block-one-sided-percentile",
    confidence: HHAD_COMPANION_CANDIDATE_GATE.bootstrapConfidence,
    percentileLowerProbability: rounded(lowerProbability, 4),
    iterations,
    seed,
    matchDays: days.length,
    rows: rows.length,
    lowerBounds: {
      brierImprovement: rounded(quantile(brierImprovements, lowerProbability)),
      logLossImprovement: rounded(quantile(logLossImprovements, lowerProbability)),
    },
  };
};

const descriptiveSettlementMetrics = (settlements) => {
  const decided = settlements.filter((row) => row.status === "WON" || row.status === "LOST");
  const won = decided.filter((row) => row.status === "WON").length;
  const lost = decided.length - won;
  const profitUnits = decided.reduce((sum, row) => sum + Number(row.profitUnits || 0), 0);
  return {
    settled: decided.length,
    won,
    lost,
    hitRate: decided.length ? rounded(won / decided.length) : null,
    profitUnits: rounded(profitUnits, 3),
    roi: decided.length ? rounded(profitUnits / decided.length) : null,
    averageOdds: decided.length ? rounded(mean(decided.map((row) => finiteNumber(row.frozen?.odds))), 3) : null,
    gateUsage: "descriptive-only",
  };
};

const evaluateHhadCompanionShadowHistory = (input = {}) => {
  const predictionSnapshots = input.predictionSnapshots || input.snapshots || [];
  const results = input.results || input.matches || [];
  const { finalEntries, counts: collectionCounts } = collectFinalHhadCompanionRevisions(predictionSnapshots);
  const { index: resultIndex, counts: resultCounts } = buildOfficialResultIndex(results);
  const settlements = [];
  const pairedRows = [];
  const finalBlockerCounts = {};
  let finalEvaluate = 0;
  let finalSkip = 0;
  let exactFinal = 0;
  let resultConflicts = 0;
  let resultEventMismatches = 0;
  let resultTimeRejected = 0;
  let missingOfficialResults = 0;
  let exactEvaluateWithoutSettlement = 0;
  let promotionTimeEligibleSettlements = 0;
  let promotionTimeIneligibleSettlements = 0;
  const promotionTimeBlockerCounts = {};

  for (const entry of finalEntries) {
    const exactReplay = entry.replay.exact && !entry.duplicateConflict;
    if (exactReplay) exactFinal += 1;
    if (entry.track.action === "EVALUATE") finalEvaluate += 1;
    else finalSkip += 1;
    for (const blocker of entry.track.blockers || []) {
      finalBlockerCounts[blocker] = (finalBlockerCounts[blocker] || 0) + 1;
    }

    let settlementRow = null;
    const promotionTimeAudit = promotionSourceTimeAudit(entry);
    for (const reason of promotionTimeAudit.reasons) {
      promotionTimeBlockerCounts[reason] = (promotionTimeBlockerCounts[reason] || 0) + 1;
    }
    if (entry.ambiguous && entry.track.action === "EVALUATE" && exactReplay) {
      exactEvaluateWithoutSettlement += 1;
    } else if (entry.track.action === "EVALUATE" && exactReplay) {
      const official = findOfficialResult(entry, resultIndex);
      resultEventMismatches += official.eventMismatches || 0;
      resultTimeRejected += official.timeRejected || 0;
      if (official.conflict) {
        resultConflicts += 1;
        exactEvaluateWithoutSettlement += 1;
      } else if (!official.result) {
        missingOfficialResults += 1;
        exactEvaluateWithoutSettlement += 1;
      } else {
        const settlement = settleHhadCompanionShadow(entry.track, {
          status: resultStatus(official.result),
          scoreHome: official.result.scoreHome ?? official.result.home,
          scoreAway: official.result.scoreAway ?? official.result.away,
          voided: official.result.voided === true,
        });
        settlementRow = {
          ...settlement,
          matchKey: entry.track.matchKey,
          matchDay: snapshotMatchDay(entry.snapshot, official.result),
          kickoffTime: snapshotKickoff(entry.snapshot) || official.result.kickoffTime || null,
          resultProvenance: {
            official: true,
            status: resultStatus(official.result),
            scoreHome: finiteNumber(official.result.scoreHome ?? official.result.home),
            scoreAway: finiteNumber(official.result.scoreAway ?? official.result.away),
            sourceUrl: official.result.sourceUrl || null,
            resultSource: official.result.resultSource || null,
            kickoffTime: official.result.kickoffTime || null,
            eventVersion: entry.eventVersion,
            resultUpdatedAt: official.result.resultUpdatedAt || null,
            resultObservedAt: official.resultTime?.observedAt || null,
            observationSource: official.resultTime?.observationSource || null,
            sourceUpdatedAt: official.resultTime?.sourceUpdatedAt || null,
            resultObservationFallback: official.resultTime?.fallback === true,
            promotionEligible: official.resultTime?.promotionEligible === true,
            effectiveResultUpdatedAt: official.resultTime?.effectiveResultUpdatedAt || null,
            resultTimeFallback: official.resultTime?.fallback === true,
          },
          promotionSourceTimeAudit: promotionTimeAudit,
        };
        settlements.push(settlementRow);
        if (promotionTimeAudit.eligible) promotionTimeEligibleSettlements += 1;
        else promotionTimeIneligibleSettlements += 1;

        if ((settlement.status === "WON" || settlement.status === "LOST")
          && OUTCOME_CODES.includes(settlement.outcomeCode)
          && promotionTimeAudit.eligible) {
          const modelScores = multiclassScores(entry.track.model?.probabilities, settlement.outcomeCode);
          const marketScores = multiclassScores(entry.track.market?.probabilities, settlement.outcomeCode);
          if (modelScores && marketScores) {
            pairedRows.push({
              matchKey: entry.track.matchKey,
              matchDay: settlementRow.matchDay,
              kickoffTime: settlementRow.kickoffTime,
              revisionHash: entry.track.revisionHash,
              exposureHash: entry.track.exposureHash,
              outcomeCode: settlement.outcomeCode,
              status: settlement.status,
              odds: settlement.frozen?.odds || null,
              profitUnits: settlement.profitUnits,
              modelBrier: modelScores.brier,
              marketBrier: marketScores.brier,
              brierImprovement: marketScores.brier - modelScores.brier,
              modelLogLoss: modelScores.logLoss,
              marketLogLoss: marketScores.logLoss,
              logLossImprovement: marketScores.logLoss - modelScores.logLoss,
            });
          }
        }
      }
    }
  }

  pairedRows.sort((left, right) => (
    String(left.matchDay || "").localeCompare(String(right.matchDay || ""))
    || String(left.kickoffTime || "").localeCompare(String(right.kickoffTime || ""))
    || String(left.exposureHash || "").localeCompare(String(right.exposureHash || ""))
  ));
  const paired = pairedMetrics(pairedRows);
  const windows = nonOverlappingWindows(pairedRows);
  const bootstrap = blockBootstrap(pairedRows, input.bootstrapIterations);
  const matchDays = new Set(pairedRows.map((row) => row.matchDay).filter(Boolean)).size;
  const matchDayCoverage = pairedRows.length
    ? pairedRows.filter((row) => row.matchDay).length / pairedRows.length
    : 0;
  const exactReplayRate = finalEntries.length ? exactFinal / finalEntries.length : null;
  const globalRiskTier = String(input.globalRiskTier || "missing").trim().toLowerCase() || "missing";
  const improvingWindows = windows.filter((window) => (
    Number(window.improvement.brier) > 0 && Number(window.improvement.logLoss) > 0
  )).length;
  const recentWindows = windows.slice(-HHAD_COMPANION_CANDIDATE_GATE.recentNonNegativeWindows);
  const recentWindowsNonNegative = recentWindows.length === HHAD_COMPANION_CANDIDATE_GATE.recentNonNegativeWindows
    && recentWindows.every((window) => (
      window.rows >= HHAD_COMPANION_CANDIDATE_GATE.minimumRowsPerWindow
      && Number.isFinite(window.improvement.brier)
      && Number.isFinite(window.improvement.logLoss)
      && Number(window.improvement.brier) >= 0
      && Number(window.improvement.logLoss) >= 0
    ));
  const checks = {
    minimumPairedNonVoidRows: pairedRows.length >= HHAD_COMPANION_CANDIDATE_GATE.minimumPairedNonVoidRows,
    sixNonOverlappingWindows: windows.length === WINDOW_COUNT
      && windows.every((window) => window.rows >= HHAD_COMPANION_CANDIDATE_GATE.minimumRowsPerWindow),
    minimumImprovingWindows: improvingWindows >= HHAD_COMPANION_CANDIDATE_GATE.minimumImprovingWindows,
    recentTwoWindowsNonNegative: recentWindowsNonNegative,
    positiveOverallBrierImprovement: Number(paired.improvement.brier) > 0,
    positiveOverallLogLossImprovement: Number(paired.improvement.logLoss) > 0,
    minimumMatchDays: matchDays >= HHAD_COMPANION_CANDIDATE_GATE.minimumMatchDays,
    completeMatchDayCoverage: matchDayCoverage === 1,
    positiveBootstrapBrierLowerBound: Number(bootstrap.lowerBounds.brierImprovement) > 0,
    positiveBootstrapLogLossLowerBound: Number(bootstrap.lowerBounds.logLossImprovement) > 0,
    exactReplayCoverage: exactReplayRate === HHAD_COMPANION_CANDIDATE_GATE.exactReplayRate,
    noConflictingDuplicateRevisions: collectionCounts.conflictingDuplicateRows === 0,
    noAmbiguousFinalRevisions: collectionCounts.ambiguousFinalGroups === 0,
    globalRiskTierStable: globalRiskTier === HHAD_COMPANION_CANDIDATE_GATE.requiredGlobalRiskTier,
  };
  const candidateReady = Object.values(checks).every(Boolean);
  const settlementByExposure = new Map(settlements.map((row) => [row.exposureHash, row]));
  const pairedByExposure = new Map(pairedRows.map((row) => [row.exposureHash, row]));
  const finalExposureRows = finalEntries.map((entry) => {
    const settlement = settlementByExposure.get(entry.track.exposureHash) || null;
    return {
      matchKey: entry.track.matchKey,
      sourceMatchId: entry.snapshot?.sourceMatchId || null,
      matchId: entry.snapshot?.matchId || null,
      kickoffTime: snapshotKickoff(entry.snapshot),
      cutoffTime: entry.track.cutoffTime || null,
      capturedAt: entry.track.sourceTimes?.capturedAt || null,
      strategyHash: entry.track.strategyHash,
      revisionHash: entry.track.revisionHash || null,
      exposureHash: entry.track.exposureHash || null,
      pairHash: entry.track.pairHash || null,
      action: entry.track.action,
      blockers: entry.track.blockers || [],
      eventVersion: entry.eventVersion,
      ambiguous: entry.ambiguous === true,
      ambiguousRevisionHashes: entry.ambiguousRevisionHashes || [],
      ambiguousExposureHashes: entry.ambiguousExposureHashes || [],
      exactReplay: entry.replay.exact && !entry.duplicateConflict,
      promotionSourceTimeAudit: promotionSourceTimeAudit(entry),
      frozen: entry.track.selection ? {
        poolCode: "HHAD",
        code: entry.track.selection.code,
        handicapLine: entry.track.selection.handicapLine,
        odds: entry.track.selection.odds,
      } : null,
      modelProbabilities: entry.track.model?.probabilities || null,
      marketProbabilities: entry.track.market?.probabilities || null,
      settlementStatus: settlement?.status || null,
      settlementHash: settlement?.settlementHash || null,
    };
  });
  const finalExposureByHash = new Map(finalExposureRows.map((row) => [row.exposureHash, row]));
  const settlementRows = settlements.map((settlement) => {
    const exposure = finalExposureByHash.get(settlement.exposureHash) || null;
    const pairedRow = pairedByExposure.get(settlement.exposureHash) || null;
    return {
      matchKey: settlement.matchKey,
      sourceMatchId: exposure?.sourceMatchId || null,
      matchId: exposure?.matchId || null,
      matchDay: settlement.matchDay,
      kickoffTime: settlement.kickoffTime,
      eventVersion: exposure?.eventVersion || null,
      cutoffTime: exposure?.cutoffTime || null,
      strategyHash: exposure?.strategyHash || STRATEGY_HASH,
      revisionHash: exposure?.revisionHash || null,
      exposureHash: settlement.exposureHash,
      pairHash: settlement.pairHash,
      frozen: settlement.frozen,
      modelProbabilities: exposure?.modelProbabilities || null,
      marketProbabilities: exposure?.marketProbabilities || null,
      officialResult: settlement.resultProvenance,
      settlement: {
        status: settlement.status,
        outcomeCode: settlement.outcomeCode,
        profitUnits: settlement.profitUnits,
        settlementHash: settlement.settlementHash,
        exposureSettlementPairHash: settlement.exposureSettlementPairHash,
      },
      pairedLosses: pairedRow ? {
        modelBrier: rounded(pairedRow.modelBrier),
        marketBrier: rounded(pairedRow.marketBrier),
        brierImprovement: rounded(pairedRow.brierImprovement),
        modelLogLoss: rounded(pairedRow.modelLogLoss),
        marketLogLoss: rounded(pairedRow.marketLogLoss),
        logLossImprovement: rounded(pairedRow.logLossImprovement),
      } : null,
      promotionSourceTimeAudit: settlement.promotionSourceTimeAudit,
    };
  });

  return {
    version: HHAD_COMPANION_EVALUATION_VERSION,
    strategy: HHAD_COMPANION_SHADOW_STRATEGY,
    strategyVersion: HHAD_COMPANION_SHADOW_VERSION,
    strategyHash: STRATEGY_HASH,
    evaluatedAt: input.evaluatedAt ? canonicalInstant(input.evaluatedAt) : null,
    onlineEffect: "shadow",
    globalRiskTier,
    candidateReady,
    candidateStatus: candidateReady ? "candidate-ready-for-manual-evaluation" : "shadow-collecting",
    promotionAllowed: false,
    counts: {
      ...collectionCounts,
      ...resultCounts,
      finalRevisions: finalEntries.length,
      finalEvaluate,
      finalSkip,
      exactReplayFinals: exactFinal,
      nonExactReplayFinals: finalEntries.length - exactFinal,
      resultConflicts,
      resultEventMismatches,
      resultTimeRejected,
      missingOfficialResults,
      exactEvaluateWithoutSettlement,
      settlementRows: settlements.length,
      settledWon: settlements.filter((row) => row.status === "WON").length,
      settledLost: settlements.filter((row) => row.status === "LOST").length,
      settledVoid: settlements.filter((row) => row.status === "VOID").length,
      settledUnsettled: settlements.filter((row) => row.status === "UNSETTLED").length,
      pairedNonVoidRows: pairedRows.length,
      pairedMatchDays: matchDays,
      promotionTimeEligibleSettlements,
      promotionTimeIneligibleSettlements,
    },
    finalBlockerCounts,
    promotionTimeBlockerCounts,
    exactReplay: {
      finals: finalEntries.length,
      exact: exactFinal,
      rate: exactReplayRate === null ? null : rounded(exactReplayRate),
      requiredRate: HHAD_COMPANION_CANDIDATE_GATE.exactReplayRate,
    },
    pairedThreeWay: paired,
    descriptive: descriptiveSettlementMetrics(settlements),
    windows: {
      type: "six-non-overlapping-chronological-match-day-windows",
      count: windows.length,
      improvingBothMetrics: improvingWindows,
      recentTwoNonNegative: recentWindowsNonNegative,
      rows: windows,
    },
    bootstrap,
    gate: {
      version: "hhad-companion-candidate-gate-v1",
      thresholds: HHAD_COMPANION_CANDIDATE_GATE,
      checks,
      candidateReady,
      interpretation: "candidate-ready permits manual evaluation only; onlineEffect remains shadow",
    },
    ...(input.includeInternalRows === true ? {
      finalExposureRows,
      settlementRows,
    } : {}),
    policy: {
      revisionSelection: "select the last current-strategy revision within matchKey+strategyHash+kickoff eventVersion before inspecting EVALUATE/SKIP; never fall back from a final SKIP; tied ordering clocks are ambiguous and unsettled",
      deduplication: "revisionHash within matchKey+strategyHash+eventVersion; exposureHash for settlement identity",
      resultPolicy: "official Sporttery result only; kickoff must match eventVersion; an attributed non-fallback resultObservedAt at or after kickoff is mandatory; missing clocks are excluded and never synthesized",
      promotionTimePolicy: "all seven frozen source/model timestamps must be valid and no later than min(cutoff,kickoff) for paired metrics and the candidate gate",
      scoring: "paired three-class Brier and log loss against the frozen devigged HHAD market",
      descriptiveOnly: ["hitRate", "profitUnits", "roi", "averageOdds"],
      onlineEffect: "shadow",
    },
  };
};

module.exports = {
  HHAD_COMPANION_CANDIDATE_GATE,
  HHAD_COMPANION_EVALUATION_VERSION,
  blockBootstrap,
  collectFinalHhadCompanionRevisions,
  evaluateHhadCompanionShadowHistory,
  multiclassScores,
  nonOverlappingWindows,
  pairedMetrics,
  replayHhadCompanionTrack,
};
