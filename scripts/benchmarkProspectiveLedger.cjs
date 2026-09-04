"use strict";

const crypto = require("node:crypto");
const {
  GOODWIN_BENCHMARK_SHADOW_POLICY,
  evaluateBenchmarkSelection,
} = require("../src/services/benchmarkSelectionPolicy.cjs");
const {
  buildResultProvenance,
  isOfficialSportteryFinal,
} = require("../src/services/matchLifecycle.cjs");

const LEDGER_VERSION = "benchmark-prospective-ledger-v2";
const AUDIT_VERSION = "goodwin-benchmark-prospective-audit-v3";
const DECISION_SNAPSHOT_VERSION = "candidate-decision-snapshot-v2";
const TIME_INTEGRITY_AUDIT_VERSION = "official-live-clock-integrity-v1";
const MINIMUM_TIME_INTEGRITY_EVIDENCE_COVERAGE = 0.95;
const GENESIS_HASH = "0".repeat(64);
const ALLOWED_PRE_MATCH_PHASES = new Set(["baseline", "mid", "late", "final"]);
const OUTCOME_CODES = Object.freeze(["1", "X", "2"]);

const finiteNumber = (value, fallback = null) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const round = (value, digits = 4) => {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

const parseTime = (value) => {
  const text = String(value || "").trim();
  if (!text) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(text)
    ? `${text.replace(" ", "T")}+08:00`
    : text;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};

const isoTime = (value) => {
  const millis = parseTime(value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
};

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [key, canonicalize(value[key])]),
  );
};

const sha256 = (value) => crypto
  .createHash("sha256")
  .update(JSON.stringify(canonicalize(value)))
  .digest("hex");

const asRows = (value) => {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.rows)) return value.rows;
  return [];
};

const sourceMatchIdFor = (row) => String(
  row?.sourceMatchId
  || String(row?.matchId || row?.id || "").replace(/^sporttery_/, "")
  || "",
).trim();

const decisionCutoffFor = (
  row,
  policy = GOODWIN_BENCHMARK_SHADOW_POLICY,
) => {
  const kickoffMillis = parseTime(row?.kickoffTime);
  if (!Number.isFinite(kickoffMillis)) return null;
  const offsetMillis = Number(policy.decisionOffsetMinutes || 10) * 60_000;
  const millis = kickoffMillis - offsetMillis;
  return {
    type: "frozen-scheduled-kickoff-offset",
    value: new Date(millis).toISOString(),
    millis,
    frozenScheduledKickoffAt: new Date(kickoffMillis).toISOString(),
    offsetMinutes: Number(policy.decisionOffsetMinutes || 10),
  };
};

const canonicalEventKeyFor = (row) => sha256({
  league: String(row?.leagueId || row?.leagueName || row?.leagueShortName || "unknown")
    .trim()
    .toLowerCase(),
  season: String(row?.season || row?.seasonName || "").trim().toLowerCase(),
  home: String(row?.homeTeamId || row?.homeTeamName || "").trim().toLowerCase(),
  away: String(row?.awayTeamId || row?.awayTeamName || "").trim().toLowerCase(),
  scheduledKickoffDate: isoTime(row?.kickoffTime)?.slice(0, 10) || null,
});

const cohortKeyFor = (row) => {
  const sourceMatchId = sourceMatchIdFor(row);
  const kickoffAt = isoTime(row?.kickoffTime);
  return sourceMatchId && kickoffAt ? `${sourceMatchId}|${kickoffAt}` : "";
};

const normalizeProbabilities = (value) => {
  const raw = Object.fromEntries(
    OUTCOME_CODES.map((code) => [code, finiteNumber(value?.[code], null)]),
  );
  if (OUTCOME_CODES.some((code) => raw[code] === null || raw[code] < 0)) return null;
  const total = OUTCOME_CODES.reduce((sum, code) => sum + raw[code], 0);
  if (!(total > 0)) return null;
  return Object.fromEntries(OUTCOME_CODES.map((code) => [code, round(raw[code] / total, 8)]));
};

const probabilitiesToPpm = (value) => {
  const normalized = normalizeProbabilities(value);
  return normalized
    ? Object.fromEntries(OUTCOME_CODES.map((code) => [code, Math.round(normalized[code] * 1_000_000)]))
    : null;
};

const probabilitiesFromPpm = (value) => normalizeProbabilities(
  value
    ? Object.fromEntries(OUTCOME_CODES.map((code) => [code, finiteNumber(value?.[code], 0) / 1_000_000]))
    : null,
);

const probabilityFromPpm = (value) => {
  const parsed = finiteNumber(value, null);
  return parsed === null ? null : parsed / 1_000_000;
};

const marketProbabilitiesFromOdds = (odds) => {
  const inverse = Object.fromEntries(
    OUTCOME_CODES.map((code) => [code, 1 / finiteNumber(odds?.[code], 0)]),
  );
  if (OUTCOME_CODES.some((code) => !Number.isFinite(inverse[code]) || inverse[code] <= 0)) {
    return null;
  }
  const total = OUTCOME_CODES.reduce((sum, code) => sum + inverse[code], 0);
  return Object.fromEntries(OUTCOME_CODES.map((code) => [code, round(inverse[code] / total, 8)]));
};

const snapshotIdentity = (snapshot) => sha256({
  sourceMatchId: sourceMatchIdFor(snapshot),
  capturedAt: isoTime(snapshot?.capturedAt),
  firstSeenAt: isoTime(snapshot?.firstSeenAt),
  phase: snapshot?.phase || null,
  decisionSnapshotVersion: snapshot?.decisionSnapshotVersion || null,
  featureSnapshotHash: snapshot?.featureSnapshotHash || null,
  decisionSnapshot: snapshot?.decisionSnapshot || null,
  best: snapshot?.best || null,
});

const buildSnapshotDecision = (snapshot, match, policy = GOODWIN_BENCHMARK_SHADOW_POLICY) => {
  const blockers = [];
  const sourceMatchId = sourceMatchIdFor(snapshot);
  const matchSourceId = sourceMatchIdFor(match);
  const capturedAt = isoTime(snapshot?.decisionSnapshot?.capturedAt || snapshot?.capturedAt);
  const lastSeenAt = isoTime(snapshot?.lastSeenAt || snapshot?.capturedAt);
  const firstSeenAt = isoTime(snapshot?.firstSeenAt);
  const decisionAt = isoTime(snapshot?.decisionSnapshot?.decisionAt);
  const deadline = decisionCutoffFor(match, policy);
  const activationMillis = parseTime(policy.activatedAt);
  const capturedMillis = parseTime(capturedAt);
  const firstSeenMillis = parseTime(firstSeenAt);
  const decisionMillis = parseTime(decisionAt);
  const ingestLagMillis = Number.isFinite(capturedMillis) && Number.isFinite(firstSeenMillis)
    ? firstSeenMillis - capturedMillis
    : null;
  const stalenessMillis = deadline && Number.isFinite(decisionMillis)
    ? deadline.millis - decisionMillis
    : null;
  const snapshotKickoffMillis = parseTime(snapshot?.kickoffTime);
  const matchKickoffMillis = parseTime(match?.kickoffTime);
  const best = snapshot?.best || {};
  const decisionSnapshot = snapshot?.decisionSnapshot || {};
  const hadMarket = decisionSnapshot?.markets?.HAD || null;
  const hadProvenance = hadMarket?.provenance || null;
  const candidate = (decisionSnapshot?.candidates || []).find((row) => (
    String(row?.market || "") === "HAD"
    && String(row?.code || "") === String(best?.tipCode || "")
  )) || null;

  if (!sourceMatchId || !matchSourceId || sourceMatchId !== matchSourceId) {
    blockers.push("source-match-id-mismatch");
  }
  if (!Number.isFinite(snapshotKickoffMillis) || !Number.isFinite(matchKickoffMillis)
    || snapshotKickoffMillis !== matchKickoffMillis) {
    blockers.push("event-version-kickoff-mismatch");
  }
  if (!ALLOWED_PRE_MATCH_PHASES.has(String(snapshot?.phase || ""))) {
    blockers.push("not-pre-match-phase");
  }
  if (String(snapshot?.status || "").toUpperCase() !== "SCHEDULED") {
    blockers.push("odds-not-explicitly-prematch");
  }
  if (snapshot?.decisionSnapshotVersion !== DECISION_SNAPSHOT_VERSION
    || decisionSnapshot?.version !== DECISION_SNAPSHOT_VERSION) {
    blockers.push("decision-snapshot-not-v2");
  }
  if (!deadline) blockers.push("missing-frozen-scheduled-kickoff");
  for (const [label, millis] of [
    ["captured-at", capturedMillis],
    ["first-seen-at", firstSeenMillis],
    ["decision-at", decisionMillis],
  ]) {
    if (!Number.isFinite(millis)) blockers.push(`${label}-missing-or-invalid`);
    else {
      if (millis < activationMillis) blockers.push(`${label}-before-activation`);
      if (deadline && millis >= deadline.millis) blockers.push(`${label}-not-before-deadline`);
    }
  }
  if (Number.isFinite(ingestLagMillis)
    && (ingestLagMillis < 0
      || ingestLagMillis > Number(policy.maximumIngestLagMinutes || 5) * 60_000)) {
    blockers.push("late-arrival-ingest-lag-outside-limit");
  }
  if (Number.isFinite(stalenessMillis)
    && (stalenessMillis < 0
      || stalenessMillis > Number(policy.maximumSnapshotStalenessMinutes || 30) * 60_000)) {
    blockers.push("cutoff-snapshot-stale");
  }
  if (decisionSnapshot?.clockAudit?.eligible !== true) {
    blockers.push("decision-clock-audit-ineligible");
  }
  if (hadProvenance?.provider?.official !== true) {
    blockers.push("had-source-not-official");
  }
  if (hadProvenance?.strict?.eligible !== true) {
    blockers.push("had-source-provenance-ineligible");
  }
  if (String(hadProvenance?.market?.sourceMatchId || "") !== sourceMatchId) {
    blockers.push("had-source-match-id-mismatch");
  }
  if (!candidate) blockers.push("matching-had-decision-candidate-missing");
  const observedAt = isoTime(hadMarket?.observedAt || hadProvenance?.timing?.providerObservedAt);
  const receivedAt = isoTime(hadMarket?.receivedAt || hadProvenance?.timing?.receivedAt);
  for (const [label, value] of [["had-observed-at", observedAt], ["had-received-at", receivedAt]]) {
    const millis = parseTime(value);
    if (!Number.isFinite(millis)) blockers.push(`${label}-missing-or-invalid`);
    else if (deadline) {
      if (millis >= deadline.millis) blockers.push(`${label}-not-before-deadline`);
      if (deadline.millis - millis > Number(policy.maximumSnapshotStalenessMinutes || 30) * 60_000) {
        blockers.push(`${label}-stale`);
      }
    }
  }

  const policyEvaluation = evaluateBenchmarkSelection({
    marketType: "BEST",
    oddsPoolCode: best?.oddsPoolCode,
    trustScore: best?.trustScore,
    odds: best?.odds,
    tipCode: best?.tipCode,
    clockEligible: blockers.length === 0,
  }, { policy });
  blockers.push(...policyEvaluation.blockers);

  const modelProbabilities = normalizeProbabilities(decisionSnapshot?.probabilities?.HAD);
  const marketProbabilities = normalizeProbabilities(hadMarket?.marketProbabilities)
    || marketProbabilitiesFromOdds(hadMarket?.odds);
  const overround = hadMarket?.odds
    ? OUTCOME_CODES.reduce((sum, code) => sum + (1 / finiteNumber(hadMarket.odds?.[code], 0)), 0) - 1
    : null;
  if (!modelProbabilities) blockers.push("had-model-probabilities-missing-or-invalid");
  if (!marketProbabilities) blockers.push("had-market-probabilities-missing-or-invalid");
  const uniqueBlockers = [...new Set(blockers)].sort();
  const evidencePayload = candidate ? {
    key: candidate.key || null,
    market: candidate.market || null,
    code: candidate.code || null,
    evidenceScoreMilli: Math.round(finiteNumber(candidate.evidenceScore, 0) * 1000),
    evidenceVersion: candidate.evidenceVersion || null,
    components: candidate.components || null,
    diagnostics: candidate.diagnostics || null,
    supportingFactors: Array.isArray(candidate.supportingFactors)
      ? [...candidate.supportingFactors]
      : [],
    evidenceReplay: candidate.evidenceReplay || null,
  } : null;
  const evidencePayloadJson = evidencePayload
    ? JSON.stringify(canonicalize(evidencePayload))
    : null;

  return {
    qualified: uniqueBlockers.length === 0,
    blockers: uniqueBlockers,
    sourceMatchId,
    cohortKey: cohortKeyFor(match),
    capturedAt,
    lastSeenAt,
    firstSeenAt,
    decisionAt,
    deadlineType: deadline?.type || null,
    deadlineAt: isoTime(deadline?.value),
    frozenScheduledKickoffAt: deadline?.frozenScheduledKickoffAt || null,
    decisionOffsetMinutes: deadline?.offsetMinutes || null,
    ingestLagSeconds: Number.isFinite(ingestLagMillis)
      ? Math.round(ingestLagMillis / 1000)
      : null,
    stalenessSeconds: Number.isFinite(stalenessMillis)
      ? Math.round(stalenessMillis / 1000)
      : null,
    snapshotHash: snapshotIdentity(snapshot),
    featureSnapshotHash: decisionSnapshot?.featureSnapshotHash
      || snapshot?.featureSnapshotHash
      || null,
    policyHash: decisionSnapshot?.policyHash || null,
    marketProvenanceHash: hadMarket?.provenanceHash || hadProvenance?.hash || null,
    sourceCycleId: decisionSnapshot?.sourceCycleId || snapshot?.sourceCycleId || null,
    tipCode: String(best?.tipCode || ""),
    oddsMilli: Math.round(finiteNumber(best?.odds, 0) * 1000),
    evidenceScoreMilli: Math.round(finiteNumber(best?.trustScore, 0) * 1000),
    decisionEvidenceScoreMilli: Math.round(finiteNumber(candidate?.evidenceScore, 0) * 1000),
    evidencePayloadJson,
    evidencePayloadHash: evidencePayloadJson ? sha256(evidencePayloadJson) : null,
    modelProbabilitiesPpm: probabilitiesToPpm(modelProbabilities),
    marketProbabilitiesPpm: probabilitiesToPpm(marketProbabilities),
    oddsIsPrematch: String(snapshot?.status || "").toUpperCase() === "SCHEDULED",
    overroundMilli: Number.isFinite(overround) ? Math.round(overround * 1000) : null,
    candidateKey: candidate?.key || null,
  };
};

const verifyLedger = (ledger, policy = GOODWIN_BENCHMARK_SHADOW_POLICY) => {
  const blockers = [];
  if (!ledger || typeof ledger !== "object") blockers.push("ledger-missing");
  if (ledger?.version !== LEDGER_VERSION) blockers.push("ledger-version-mismatch");
  if (ledger?.policyVersion !== policy.version) blockers.push("ledger-policy-version-mismatch");
  if (ledger?.activatedAt !== policy.activatedAt) blockers.push("ledger-activation-mismatch");
  const events = Array.isArray(ledger?.events) ? ledger.events : [];
  let previousHash = GENESIS_HASH;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event?.sequence !== index + 1) blockers.push(`sequence-mismatch:${index + 1}`);
    if (event?.previousHash !== previousHash) blockers.push(`previous-hash-mismatch:${index + 1}`);
    const { rowHash, ...hashInput } = event || {};
    const expectedHash = sha256(hashInput);
    if (rowHash !== expectedHash) blockers.push(`row-hash-mismatch:${index + 1}`);
    previousHash = String(rowHash || "");
  }
  const expectedRoot = events.length ? previousHash : GENESIS_HASH;
  if (ledger?.rootHash !== expectedRoot) blockers.push("root-hash-mismatch");
  return {
    ok: blockers.length === 0,
    blockers,
    events: events.length,
    rootHash: expectedRoot,
  };
};

const createLedger = (evaluatedAt, policy = GOODWIN_BENCHMARK_SHADOW_POLICY) => ({
  version: LEDGER_VERSION,
  policyVersion: policy.version,
  activatedAt: policy.activatedAt,
  createdAt: evaluatedAt,
  updatedAt: evaluatedAt,
  rootHash: GENESIS_HASH,
  events: [],
});

const appendEvent = (ledger, event) => {
  const previousHash = ledger.events.length
    ? ledger.events[ledger.events.length - 1].rowHash
    : GENESIS_HASH;
  const row = {
    sequence: ledger.events.length + 1,
    previousHash,
    ...event,
  };
  row.rowHash = sha256(row);
  ledger.events.push(row);
  ledger.rootHash = row.rowHash;
  ledger.updatedAt = event.recordedAt || ledger.updatedAt;
  return row;
};

const dedupeMatches = (rows) => {
  const byKey = new Map();
  for (const match of rows || []) {
    const key = cohortKeyFor(match);
    if (!key) continue;
    const score = (
      (String(match?.status || "").toUpperCase() === "FINISHED" ? 8 : 0)
      + (match?.resultProvenance?.promotionEligible === true ? 4 : 0)
      + (Number.isFinite(Number(match?.scoreHome)) ? 1 : 0)
      + (Number.isFinite(Number(match?.scoreAway)) ? 1 : 0)
    );
    const previous = byKey.get(key);
    if (!previous || score >= previous.score) byKey.set(key, { score, match });
  }
  return [...byKey.values()].map((entry) => entry.match);
};

const selectCutoffSnapshot = (snapshots, match, policy) => {
  const decisions = (snapshots || [])
    .map((snapshot) => buildSnapshotDecision(snapshot, match, policy))
    .sort((left, right) => (
      parseTime(left.decisionAt) - parseTime(right.decisionAt)
      || parseTime(left.capturedAt) - parseTime(right.capturedAt)
      || left.snapshotHash.localeCompare(right.snapshotHash)
    ));
  const deadline = decisionCutoffFor(match, policy);
  const preCutoff = decisions.filter((decision) => (
    deadline
    && Number.isFinite(parseTime(decision.decisionAt))
    && parseTime(decision.decisionAt) < deadline.millis
    && Number.isFinite(parseTime(decision.capturedAt))
    && parseTime(decision.capturedAt) < deadline.millis
  ));
  const lastPreCutoff = preCutoff.length ? preCutoff[preCutoff.length - 1] : null;
  return {
    selected: lastPreCutoff?.qualified ? lastPreCutoff : null,
    cutoffDecision: lastPreCutoff,
    decisions,
    blockers: lastPreCutoff
      ? lastPreCutoff.blockers
      : ["missing-pre-cutoff-decision-snapshot"],
  };
};

const oddsRowClosingDecision = (row, selection) => {
  const blockers = [];
  const capturedAt = isoTime(row?.capturedAt);
  const firstSeenAt = isoTime(row?.firstSeenAt);
  const observedAt = isoTime(
    row?.oddsObservedAt
    || row?.marketProvenance?.timing?.providerObservedAt,
  );
  const receivedAt = isoTime(
    row?.oddsReceivedAt
    || row?.marketProvenance?.timing?.receivedAt,
  );
  const deadlineMillis = parseTime(selection?.deadlineAt);
  const capturedMillis = parseTime(capturedAt);
  const firstSeenMillis = parseTime(firstSeenAt);
  const ingestLagMillis = Number.isFinite(capturedMillis) && Number.isFinite(firstSeenMillis)
    ? firstSeenMillis - capturedMillis
    : null;
  if (sourceMatchIdFor(row) !== selection?.sourceMatchId) blockers.push("closing-source-match-mismatch");
  if (String(row?.poolCode || "") !== "HAD") blockers.push("closing-pool-not-had");
  if (row?.marketProvenance?.provider?.official !== true) blockers.push("closing-source-not-official");
  if (row?.marketProvenance?.strict?.eligible !== true) blockers.push("closing-provenance-ineligible");
  for (const [label, value] of [
    ["captured", capturedAt],
    ["first-seen", firstSeenAt],
    ["observed", observedAt],
    ["received", receivedAt],
  ]) {
    const millis = parseTime(value);
    if (!Number.isFinite(millis)) blockers.push(`closing-${label}-missing`);
    else {
      if (millis >= deadlineMillis) blockers.push(`closing-${label}-not-before-deadline`);
      if (deadlineMillis - millis
        > Number(GOODWIN_BENCHMARK_SHADOW_POLICY.maximumSnapshotStalenessMinutes || 30) * 60_000) {
        blockers.push(`closing-${label}-stale`);
      }
    }
  }
  if (Number.isFinite(ingestLagMillis)
    && (ingestLagMillis < 0
      || ingestLagMillis
        > Number(GOODWIN_BENCHMARK_SHADOW_POLICY.maximumIngestLagMinutes || 5) * 60_000)) {
    blockers.push("closing-ingest-lag-outside-limit");
  }
  const odds = { "1": row?.odds1, X: row?.oddsX, "2": row?.odds2 };
  const probabilities = marketProbabilitiesFromOdds(odds);
  if (!probabilities) blockers.push("closing-odds-invalid");
  return {
    qualified: blockers.length === 0,
    blockers,
    capturedAt,
    observedAt,
    receivedAt,
    probabilities,
    snapshotHash: sha256(row),
  };
};

const selectClosingOdds = (oddsRows, selection) => {
  const candidates = (oddsRows || [])
    .map((row) => oddsRowClosingDecision(row, selection))
    .filter((row) => row.qualified)
    .sort((left, right) => (
      parseTime(left.observedAt) - parseTime(right.observedAt)
      || parseTime(left.receivedAt) - parseTime(right.receivedAt)
      || parseTime(left.capturedAt) - parseTime(right.capturedAt)
      || left.snapshotHash.localeCompare(right.snapshotHash)
    ));
  return candidates.length ? candidates[candidates.length - 1] : null;
};

const resultDecision = (match) => {
  const declaredProvenance = match?.resultProvenance || {};
  const validatedProvenance = buildResultProvenance(match);
  const provenance = validatedProvenance || declaredProvenance;
  const actualKickoffAt = isoTime(
    provenance?.actualKickoffAt
    ?? provenance?.actualKickoffTime
    ?? match?.actualKickoffAt
    ?? match?.actualKickoffTime
    ?? match?.resultMeta?.actualKickoffAt
    ?? match?.resultMeta?.actualKickoffTime,
  );
  const actualKickoffSource = String(
    provenance?.actualKickoffSource
    ?? match?.actualKickoffSource
    ?? match?.resultMeta?.actualKickoffSource
    ?? "",
  ).trim() || null;
  const firstInPlayObservedAt = isoTime(
    provenance?.firstInPlayObservedAt
    ?? match?.firstInPlayObservedAt
    ?? match?.resultMeta?.firstInPlayObservedAt,
  );
  const inPlayObservationSource = String(
    provenance?.inPlayObservationSource
    ?? match?.inPlayObservationSource
    ?? match?.resultMeta?.inPlayObservationSource
    ?? "",
  ).trim() || null;
  const ft90Home = finiteNumber(
    declaredProvenance?.ft90Home
      ?? validatedProvenance?.ft90Home
      ?? match?.ft90Home
      ?? match?.score90Home,
    null,
  );
  const ft90Away = finiteNumber(
    declaredProvenance?.ft90Away
      ?? validatedProvenance?.ft90Away
      ?? match?.ft90Away
      ?? match?.score90Away,
    null,
  );
  const periodSplitPresent = Number.isInteger(ft90Home) && Number.isInteger(ft90Away);
  const competitionLabel = [
    match?.leagueName,
    match?.leagueShortName,
    match?.competitionName,
  ].filter(Boolean).join(" ");
  const cupOrKnockout = /杯|cup|欧冠|欧联|冠军联赛|champions league|淘汰|playoff/i
    .test(competitionLabel);
  const scoreHome = periodSplitPresent ? ft90Home : finiteNumber(match?.scoreHome, null);
  const scoreAway = periodSplitPresent ? ft90Away : finiteNumber(match?.scoreAway, null);
  const auditSampleRequired = Number.parseInt(
    sha256(sourceMatchIdFor(match)).slice(0, 8),
    16,
  ) % 10 === 0;
  const secondaryResultVerified = (
    declaredProvenance?.secondaryResultVerified === true
    || match?.resultCrossCheck?.verified === true
    || match?.resultAudit?.verified === true
  );
  const blockers = [];
  if (String(match?.status || "").toUpperCase() !== "FINISHED") blockers.push("result-not-finished");
  if (!Number.isInteger(scoreHome) || !Number.isInteger(scoreAway)) blockers.push("result-score-invalid");
  if (!isOfficialSportteryFinal(match)) blockers.push("result-not-official-sporttery-final");
  if (String(validatedProvenance?.provider || "").toLowerCase() !== "sporttery") {
    blockers.push("result-provider-not-sporttery");
  }
  if (provenance?.official !== true) blockers.push("result-not-official");
  if (provenance?.trusted !== true) blockers.push("result-not-trusted");
  if (provenance?.eventVersionConsistent !== true) blockers.push("result-event-version-inconsistent");
  if (provenance?.observationAfterKickoff !== true) {
    blockers.push("result-observed-before-kickoff-or-unattributed");
  }
  if (provenance?.resultObservationFallback !== false) {
    blockers.push("result-observation-fallback");
  }
  if (provenance?.promotionEligible !== true) blockers.push("result-not-promotion-eligible");
  if (cupOrKnockout && !periodSplitPresent) blockers.push("ft90-period-split-missing");
  if (auditSampleRequired && !secondaryResultVerified) {
    blockers.push("secondary-result-audit-required");
  }
  if (sourceMatchIdFor(provenance) !== sourceMatchIdFor(match)) {
    blockers.push("result-source-match-id-mismatch");
  }
  const kickoffAt = isoTime(match?.kickoffTime);
  if (isoTime(provenance?.eventVersion) !== kickoffAt) blockers.push("result-event-version-mismatch");
  const actualCode = !Number.isInteger(scoreHome) || !Number.isInteger(scoreAway)
    ? null
    : scoreHome > scoreAway ? "1" : scoreHome < scoreAway ? "2" : "X";
  return {
    qualified: blockers.length === 0,
    blockers,
    scoreHome,
    scoreAway,
    periodSplitPresent,
    auditSampleRequired,
    secondaryResultVerified,
    actualCode,
    actualKickoffAt,
    actualKickoffSource,
    firstInPlayObservedAt,
    inPlayObservationSource,
    observedAt: isoTime(provenance?.observedAt || match?.resultObservedAt),
    provenanceHash: sha256(provenance),
    eventVersion: isoTime(provenance?.eventVersion),
  };
};

const updateLedger = ({
  priorLedger = null,
  matches = [],
  snapshots = [],
  oddsRows = [],
  evaluatedAt = new Date().toISOString(),
  policy = GOODWIN_BENCHMARK_SHADOW_POLICY,
} = {}) => {
  const activationMillis = parseTime(policy.activatedAt);
  const evaluatedMillis = parseTime(evaluatedAt);
  const initialLedger = priorLedger || createLedger(evaluatedAt, policy);
  const verification = verifyLedger(initialLedger, policy);
  if (!verification.ok) {
    return {
      ledger: initialLedger,
      changed: false,
      chainValid: false,
      blockers: verification.blockers,
    };
  }
  const ledger = JSON.parse(JSON.stringify(initialLedger));
  const existingUniverseKeys = new Set(
    ledger.events
      .filter((event) => event?.type === "universe")
      .map((event) => event.cohortKey),
  );
  const existingDecisionKeys = new Set(
    ledger.events
      .filter((event) => ["selection", "exclusion"].includes(event?.type))
      .map((event) => event.cohortKey),
  );
  const selectionEvents = () => ledger.events.filter((event) => event?.type === "selection");
  const snapshotsByKey = new Map();
  for (const snapshot of snapshots || []) {
    const key = cohortKeyFor(snapshot);
    if (!key) continue;
    const list = snapshotsByKey.get(key) || [];
    list.push(snapshot);
    snapshotsByKey.set(key, list);
  }
  const oddsBySourceMatch = new Map();
  for (const row of oddsRows || []) {
    const id = sourceMatchIdFor(row);
    if (!id) continue;
    const list = oddsBySourceMatch.get(id) || [];
    list.push(row);
    oddsBySourceMatch.set(id, list);
  }
  const dedupedMatches = dedupeMatches(asRows(matches));
  for (const match of dedupedMatches.sort((left, right) => (
    parseTime(left?.kickoffTime) - parseTime(right?.kickoffTime)
    || cohortKeyFor(left).localeCompare(cohortKeyFor(right))
  ))) {
    const cohortKey = cohortKeyFor(match);
    if (!cohortKey) continue;
    const deadline = decisionCutoffFor(match, policy);
    const kickoffMillis = parseTime(match?.kickoffTime);
    if (!deadline || !Number.isFinite(kickoffMillis)
      || deadline.millis < activationMillis) {
      continue;
    }
    if (!existingUniverseKeys.has(cohortKey)) {
      const canonicalEventKey = canonicalEventKeyFor(match);
      const identityConflict = ledger.events.find((event) => (
        event?.type === "universe"
        && event.canonicalEventKey === canonicalEventKey
        && event.cohortKey !== cohortKey
      )) || null;
      appendEvent(ledger, {
        type: "universe",
        recordedAt: evaluatedAt,
        cohortKey,
        canonicalEventKey,
        sourceMatchId: sourceMatchIdFor(match),
        matchId: match?.id || null,
        businessDate: match?.businessDate || null,
        leagueName: match?.leagueName || match?.leagueShortName || "unknown",
        leagueId: match?.leagueId || match?.leagueName || match?.leagueShortName || "unknown",
        homeTeamId: match?.homeTeamId || null,
        awayTeamId: match?.awayTeamId || null,
        homeTeamName: match?.homeTeamName || null,
        awayTeamName: match?.awayTeamName || null,
        frozenScheduledKickoffAt: deadline.frozenScheduledKickoffAt,
        decisionCutoffAt: deadline.value,
        decisionOffsetMinutes: deadline.offsetMinutes,
        fixtureSnapshotHash: sha256({
          sourceMatchId: sourceMatchIdFor(match),
          leagueName: match?.leagueName || null,
          homeTeamId: match?.homeTeamId || null,
          awayTeamId: match?.awayTeamId || null,
          homeTeamName: match?.homeTeamName || null,
          awayTeamName: match?.awayTeamName || null,
          kickoffTime: isoTime(match?.kickoffTime),
          cutoffTime: isoTime(match?.cutoffTime),
        }),
        createdBeforeCutoff: evaluatedMillis < deadline.millis,
        identityConflictWith: identityConflict?.rowHash || null,
        policyVersion: policy.version,
      });
      existingUniverseKeys.add(cohortKey);
    }
    if (existingDecisionKeys.has(cohortKey) || deadline.millis > evaluatedMillis) {
      continue;
    }
    const universe = ledger.events.find((event) => (
      event?.type === "universe" && event.cohortKey === cohortKey
    ));
    if (universe?.createdBeforeCutoff !== true) {
      appendEvent(ledger, {
        type: "exclusion",
        status: "coverage_gap",
        recordedAt: evaluatedAt,
        cohortKey,
        sourceMatchId: sourceMatchIdFor(match),
        matchId: match?.id || null,
        businessDate: match?.businessDate || null,
        leagueName: match?.leagueName || match?.leagueShortName || "unknown",
        kickoffAt: isoTime(match?.kickoffTime),
        cutoffAt: deadline.value,
        policyVersion: policy.version,
        candidateSnapshots: 0,
        cutoffSnapshotHash: null,
        blockers: ["universe-created-after-cutoff"],
        formalOnlineEffect: false,
      });
      existingDecisionKeys.add(cohortKey);
      continue;
    }
    if (evaluatedMillis >= kickoffMillis) {
      appendEvent(ledger, {
        type: "exclusion",
        status: "coverage_gap",
        recordedAt: evaluatedAt,
        cohortKey,
        sourceMatchId: sourceMatchIdFor(match),
        matchId: match?.id || null,
        businessDate: match?.businessDate || null,
        leagueName: match?.leagueName || match?.leagueShortName || "unknown",
        homeTeamName: match?.homeTeamName || null,
        awayTeamName: match?.awayTeamName || null,
        kickoffAt: isoTime(match?.kickoffTime),
        cutoffAt: deadline.value,
        policyVersion: policy.version,
        candidateSnapshots: 0,
        cutoffSnapshotHash: null,
        blockers: ["deadline-heartbeat-missed-before-kickoff"],
        formalOnlineEffect: false,
      });
      existingDecisionKeys.add(cohortKey);
      continue;
    }
    const selection = selectCutoffSnapshot(
      snapshotsByKey.get(cohortKey) || [],
      match,
      policy,
    );
    if (selection.selected) {
      appendEvent(ledger, {
        type: "selection",
        recordedAt: evaluatedAt,
        cohortKey,
        sourceMatchId: sourceMatchIdFor(match),
        matchId: match?.id || null,
        businessDate: match?.businessDate || null,
        leagueName: match?.leagueName || match?.leagueShortName || "unknown",
        homeTeamName: match?.homeTeamName || null,
        awayTeamName: match?.awayTeamName || null,
        kickoffAt: isoTime(match?.kickoffTime),
        cutoffAt: deadline.value,
        policyVersion: policy.version,
        formalOnlineEffect: false,
        ...selection.selected,
      });
    } else {
      appendEvent(ledger, {
        type: "exclusion",
        status: !selection.cutoffDecision
          ? "coverage_gap"
          : selection.blockers.every((blocker) => [
              "market-not-best",
              "pool-not-had",
              "evidence-below-threshold",
              "odds-outside-band",
              "invalid-one-x-two-tip",
            ].includes(blocker))
            ? "abstain_filter"
            : "blocker",
        recordedAt: evaluatedAt,
        cohortKey,
        sourceMatchId: sourceMatchIdFor(match),
        matchId: match?.id || null,
        businessDate: match?.businessDate || null,
        leagueName: match?.leagueName || match?.leagueShortName || "unknown",
        homeTeamName: match?.homeTeamName || null,
        awayTeamName: match?.awayTeamName || null,
        kickoffAt: isoTime(match?.kickoffTime),
        cutoffAt: deadline.value,
        policyVersion: policy.version,
        candidateSnapshots: selection.decisions.length,
        cutoffSnapshotHash: selection.cutoffDecision?.snapshotHash || null,
        blockers: selection.blockers,
        formalOnlineEffect: false,
      });
    }
    existingDecisionKeys.add(cohortKey);
  }

  const matchByKey = new Map(dedupedMatches.map((match) => [cohortKeyFor(match), match]));
  const matchBySource = new Map();
  for (const match of dedupedMatches) {
    const sourceMatchId = sourceMatchIdFor(match);
    if (sourceMatchId) matchBySource.set(sourceMatchId, match);
  }
  const settlementEvents = ledger.events.filter((event) => event?.type === "settlement");
  const settlementHoldEvents = ledger.events.filter((event) => event?.type === "settlement_hold");
  for (const selection of selectionEvents()) {
    const match = matchByKey.get(selection.cohortKey);
    const priorSettlements = settlementEvents.filter(
      (event) => event.selectionHash === selection.rowHash,
    );
    const latest = priorSettlements[priorSettlements.length - 1] || null;
    if (!match) {
      const revisedEvent = matchBySource.get(selection.sourceMatchId);
      if (revisedEvent && cohortKeyFor(revisedEvent) !== selection.cohortKey
        && latest?.voidReason !== "POSTPONED_EVENT_VERSION_CHANGED") {
        appendEvent(ledger, {
          type: "settlement",
          recordedAt: evaluatedAt,
          cohortKey: selection.cohortKey,
          sourceMatchId: selection.sourceMatchId,
          selectionHash: selection.rowHash,
          revision: priorSettlements.length + 1,
          supersedesSettlementHash: latest?.rowHash || null,
          resultObservedAt: null,
          resultEventVersion: isoTime(revisedEvent?.kickoffTime),
          resultProvenanceHash: null,
          scoreHome: null,
          scoreAway: null,
          actualCode: null,
          outcome: "VOID",
          voidReason: "POSTPONED_EVENT_VERSION_CHANGED",
          replacementCohortKey: cohortKeyFor(revisedEvent),
          closingSnapshotHash: null,
          closingObservedAt: null,
          closingMarketProbabilitiesPpm: null,
          clvPpm: null,
        });
        settlementEvents.push(ledger.events[ledger.events.length - 1]);
      }
      continue;
    }
    const result = resultDecision(match);
    if (!result.qualified) {
      const holdSignature = sha256({
        selectionHash: selection.rowHash,
        blockers: result.blockers,
        resultProvenanceHash: result.provenanceHash,
      });
      const latestHold = settlementHoldEvents
        .filter((event) => event.selectionHash === selection.rowHash)
        .slice(-1)[0] || null;
      if (latestHold?.holdSignature !== holdSignature) {
        appendEvent(ledger, {
          type: "settlement_hold",
          recordedAt: evaluatedAt,
          cohortKey: selection.cohortKey,
          sourceMatchId: selection.sourceMatchId,
          selectionHash: selection.rowHash,
          holdSignature,
          blockers: result.blockers,
          resultObservedAt: result.observedAt,
          resultProvenanceHash: result.provenanceHash,
          periodSplitPresent: result.periodSplitPresent,
          auditSampleRequired: result.auditSampleRequired,
          secondaryResultVerified: result.secondaryResultVerified,
        });
        settlementHoldEvents.push(ledger.events[ledger.events.length - 1]);
      }
      continue;
    }
    const actualKickoffMillis = parseTime(result.actualKickoffAt);
    const firstInPlayObservedMillis = parseTime(result.firstInPlayObservedAt);
    const decisionCutoffMillis = parseTime(selection.cutoffAt);
    const actualKickoffInvalid = Number.isFinite(actualKickoffMillis)
      && Number.isFinite(decisionCutoffMillis)
      && actualKickoffMillis <= decisionCutoffMillis;
    const inPlayObservedBeforeCutoff = Number.isFinite(firstInPlayObservedMillis)
      && Number.isFinite(decisionCutoffMillis)
      && firstInPlayObservedMillis <= decisionCutoffMillis;
    if (actualKickoffInvalid || inPlayObservedBeforeCutoff) {
      const voidReason = actualKickoffInvalid
        ? "ACTUAL_KICKOFF_NOT_AFTER_DECISION_CUTOFF"
        : "IN_PLAY_OBSERVED_NOT_AFTER_DECISION_CUTOFF";
      if (latest?.outcome === "VOID"
        && latest?.voidReason === voidReason
        && latest?.actualKickoffAt === result.actualKickoffAt
        && latest?.firstInPlayObservedAt === result.firstInPlayObservedAt
        && latest?.resultProvenanceHash === result.provenanceHash) {
        continue;
      }
      appendEvent(ledger, {
        type: "settlement",
        recordedAt: evaluatedAt,
        cohortKey: selection.cohortKey,
        sourceMatchId: selection.sourceMatchId,
        selectionHash: selection.rowHash,
        revision: priorSettlements.length + 1,
        supersedesSettlementHash: latest?.rowHash || null,
        resultObservedAt: result.observedAt,
        resultEventVersion: result.eventVersion,
        resultProvenanceHash: result.provenanceHash,
        scoreHome: result.scoreHome,
        scoreAway: result.scoreAway,
        periodSplitPresent: result.periodSplitPresent,
        auditSampleRequired: result.auditSampleRequired,
        secondaryResultVerified: result.secondaryResultVerified,
        actualCode: result.actualCode,
        actualKickoffAt: result.actualKickoffAt,
        actualKickoffSource: result.actualKickoffSource,
        firstInPlayObservedAt: result.firstInPlayObservedAt,
        inPlayObservationSource: result.inPlayObservationSource,
        outcome: "VOID",
        voidReason,
        closingSnapshotHash: null,
        closingObservedAt: null,
        closingMarketProbabilitiesPpm: null,
        clvPpm: null,
      });
      settlementEvents.push(ledger.events[ledger.events.length - 1]);
      continue;
    }
    if (latest
      && latest.scoreHome === result.scoreHome
      && latest.scoreAway === result.scoreAway
      && latest.resultProvenanceHash === result.provenanceHash) {
      continue;
    }
    const closing = selectClosingOdds(
      oddsBySourceMatch.get(selection.sourceMatchId) || [],
      selection,
    );
    const publishedMarketProbability = probabilityFromPpm(
      selection?.marketProbabilitiesPpm?.[selection.tipCode],
    );
    const closingMarketProbability = finiteNumber(
      closing?.probabilities?.[selection.tipCode],
      null,
    );
    appendEvent(ledger, {
      type: "settlement",
      recordedAt: evaluatedAt,
      cohortKey: selection.cohortKey,
      sourceMatchId: selection.sourceMatchId,
      selectionHash: selection.rowHash,
      revision: priorSettlements.length + 1,
      supersedesSettlementHash: latest?.rowHash || null,
      resultObservedAt: result.observedAt,
      resultEventVersion: result.eventVersion,
      resultProvenanceHash: result.provenanceHash,
      scoreHome: result.scoreHome,
      scoreAway: result.scoreAway,
      periodSplitPresent: result.periodSplitPresent,
      auditSampleRequired: result.auditSampleRequired,
      secondaryResultVerified: result.secondaryResultVerified,
      actualKickoffAt: result.actualKickoffAt,
      actualKickoffSource: result.actualKickoffSource,
      firstInPlayObservedAt: result.firstInPlayObservedAt,
      inPlayObservationSource: result.inPlayObservationSource,
      actualCode: result.actualCode,
      outcome: result.actualCode === selection.tipCode ? "WON" : "LOST",
      closingSnapshotHash: closing?.snapshotHash || null,
      closingObservedAt: closing?.observedAt || null,
      closingMarketProbabilitiesPpm: probabilitiesToPpm(closing?.probabilities),
      clvPpm: publishedMarketProbability > 0 && closingMarketProbability > 0
        ? Math.round(((closingMarketProbability / publishedMarketProbability) - 1) * 1_000_000)
        : null,
    });
    settlementEvents.push(ledger.events[ledger.events.length - 1]);
  }

  const completedCheckpointSet = new Set(
    ledger.events
      .filter((event) => event?.type === "gate_evaluation")
      .map((event) => Number(event.checkpointN)),
  );
  const currentSettledRows = metricsForLedger(ledger, {
    minimumRowsPerWindow: policy.minimumRowsPerWindow,
  }).cohort.settled;
  for (const checkpointN of policy.reviewCheckpoints || []) {
    if (currentSettledRows < checkpointN || completedCheckpointSet.has(Number(checkpointN))) continue;
    const checkpointSummary = metricsForLedger(ledger, {
      maximumSettledRows: Number(checkpointN),
      minimumRowsPerWindow: policy.minimumRowsPerWindow,
    });
    const checks = gateChecksForSummary(checkpointSummary, policy, true);
    const datasetHash = sha256(
      checkpointSummary.joined
        .filter((row) => row.settlement)
        .map((row) => ({
          selectionHash: row.selection.rowHash,
          settlementHash: row.settlement.rowHash,
        })),
    );
    appendEvent(ledger, {
      type: "gate_evaluation",
      recordedAt: evaluatedAt,
      policyVersion: policy.version,
      checkpointN: Number(checkpointN),
      auditVersion: AUDIT_VERSION,
      datasetHash,
      checks,
      passed: Object.values(checks).every(Boolean),
      metricsJson: JSON.stringify(canonicalize(checkpointSummary.metrics)),
      metricsHash: sha256(checkpointSummary.metrics),
      cohort: checkpointSummary.cohort,
    });
    completedCheckpointSet.add(Number(checkpointN));
  }

  const changed = ledger.events.length !== initialLedger.events.length;
  const finalVerification = verifyLedger(ledger, policy);
  return {
    ledger,
    changed,
    chainValid: finalVerification.ok,
    blockers: finalVerification.blockers,
  };
};

const wilsonInterval = (wins, total, z = 1.96) => {
  if (!total) return null;
  const probability = wins / total;
  const denominator = 1 + (z * z) / total;
  const centre = (probability + (z * z) / (2 * total)) / denominator;
  const margin = z * Math.sqrt(
    (probability * (1 - probability)) / total + (z * z) / (4 * total * total),
  ) / denominator;
  return [Math.max(0, centre - margin), Math.min(1, centre + margin)];
};

const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[midpoint]
    : (sorted[midpoint - 1] + sorted[midpoint]) / 2;
};

const brierFor = (rows, field) => {
  const usable = rows.filter((row) => probabilitiesFromPpm(row?.selection?.[field]));
  if (!usable.length) return null;
  const total = usable.reduce((sum, row) => {
    const probabilities = probabilitiesFromPpm(row.selection[field]);
    return sum + OUTCOME_CODES.reduce((inner, code) => (
      inner + ((probabilities[code] - (row.settlement.actualCode === code ? 1 : 0)) ** 2)
    ), 0);
  }, 0);
  return round(total / usable.length, 8);
};

const expectedCalibrationError = (rows, bins = 10) => {
  const usable = rows.map((row) => ({
    probability: probabilityFromPpm(
      row?.selection?.modelProbabilitiesPpm?.[row?.selection?.tipCode],
    ),
    hit: row?.settlement?.outcome === "WON" ? 1 : 0,
  })).filter((row) => row.probability !== null && row.probability >= 0 && row.probability <= 1);
  if (!usable.length) return null;
  let ece = 0;
  for (let index = 0; index < bins; index += 1) {
    const lower = index / bins;
    const upper = (index + 1) / bins;
    const bucket = usable.filter((row) => (
      row.probability >= lower
      && (index === bins - 1 ? row.probability <= upper : row.probability < upper)
    ));
    if (!bucket.length) continue;
    const confidence = bucket.reduce((sum, row) => sum + row.probability, 0) / bucket.length;
    const accuracy = bucket.reduce((sum, row) => sum + row.hit, 0) / bucket.length;
    ece += (bucket.length / usable.length) * Math.abs(accuracy - confidence);
  }
  return round(ece, 8);
};

const spiegelhalterZ = (rows) => {
  const usable = rows.map((row) => ({
    probability: probabilityFromPpm(
      row?.selection?.modelProbabilitiesPpm?.[row?.selection?.tipCode],
    ),
    hit: row?.settlement?.outcome === "WON" ? 1 : 0,
  })).filter((row) => row.probability !== null && row.probability > 0 && row.probability < 1);
  if (!usable.length) return null;
  const numerator = usable.reduce((sum, row) => (
    sum + ((row.hit - row.probability) * (1 - (2 * row.probability)))
  ), 0);
  const variance = usable.reduce((sum, row) => (
    sum + (((1 - (2 * row.probability)) ** 2) * row.probability * (1 - row.probability))
  ), 0);
  return variance > 0 ? round(numerator / Math.sqrt(variance), 8) : null;
};

const bootstrapBrierSkillLower = (rows, iterations = 500, quantile = 0.05) => {
  const usable = rows.filter((row) => (
    probabilitiesFromPpm(row?.selection?.modelProbabilitiesPpm)
    && probabilitiesFromPpm(row?.selection?.marketProbabilitiesPpm)
  ));
  if (usable.length < 2) return null;
  let seed = Number.parseInt(
    sha256(usable.map((row) => `${row.selection.rowHash}:${row.settlement.rowHash}`)).slice(0, 8),
    16,
  ) >>> 0;
  const nextRandom = () => {
    seed = ((1664525 * seed) + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };
  const scores = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let modelTotal = 0;
    let marketTotal = 0;
    for (let index = 0; index < usable.length; index += 1) {
      const row = usable[Math.floor(nextRandom() * usable.length)];
      const model = probabilitiesFromPpm(row.selection.modelProbabilitiesPpm);
      const market = probabilitiesFromPpm(row.selection.marketProbabilitiesPpm);
      modelTotal += OUTCOME_CODES.reduce((sum, code) => (
        sum + ((model[code] - (row.settlement.actualCode === code ? 1 : 0)) ** 2)
      ), 0);
      marketTotal += OUTCOME_CODES.reduce((sum, code) => (
        sum + ((market[code] - (row.settlement.actualCode === code ? 1 : 0)) ** 2)
      ), 0);
    }
    if (marketTotal > 0) scores.push(1 - (modelTotal / marketTotal));
  }
  scores.sort((left, right) => left - right);
  return scores.length
    ? round(scores[Math.floor((scores.length - 1) * quantile)], 8)
    : null;
};

const isoWeekKey = (value) => {
  const millis = parseTime(value);
  if (!Number.isFinite(millis)) return "unknown";
  const date = new Date(millis);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date - yearStart) / 86_400_000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
};

const buildStrictTimeWindows = (rows, minimumRowsPerWindow = 15) => {
  const grouped = new Map();
  for (const row of rows) {
    const key = isoWeekKey(row?.selection?.kickoffAt);
    const bucket = grouped.get(key) || [];
    bucket.push(row);
    grouped.set(key, bucket);
  }
  return [...grouped.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([id, subset], index) => {
      const ordered = [...subset].sort((left, right) => (
        parseTime(left?.selection?.kickoffAt) - parseTime(right?.selection?.kickoffAt)
        || left.selection.rowHash.localeCompare(right.selection.rowHash)
      ));
      const won = ordered.filter((row) => row.settlement.outcome === "WON").length;
      return {
        index: index + 1,
        id,
        rows: ordered.length,
        eligible: ordered.length >= minimumRowsPerWindow,
        startAt: ordered[0]?.selection?.kickoffAt || null,
        endAt: ordered[ordered.length - 1]?.selection?.kickoffAt || null,
        hitRate: ordered.length ? round(won / ordered.length, 6) : null,
      };
    });
};

const metricsForLedger = (ledger, options = {}) => {
  const universes = ledger.events.filter((event) => event?.type === "universe");
  const selections = ledger.events.filter((event) => event?.type === "selection");
  const exclusions = ledger.events.filter((event) => event?.type === "exclusion");
  const settlements = ledger.events.filter((event) => event?.type === "settlement");
  const settlementHolds = ledger.events.filter((event) => event?.type === "settlement_hold");
  const latestSettlementBySelection = new Map();
  for (const settlement of settlements) {
    latestSettlementBySelection.set(settlement.selectionHash, settlement);
  }
  const joined = selections.map((selection) => ({
    selection,
    settlement: latestSettlementBySelection.get(selection.rowHash) || null,
  }));
  const voidRows = joined.filter((row) => row.settlement?.outcome === "VOID");
  const orderedSettled = joined.filter((row) => (
    ["WON", "LOST"].includes(row.settlement?.outcome)
  )).sort((left, right) => (
    parseTime(left?.selection?.kickoffAt) - parseTime(right?.selection?.kickoffAt)
    || left.selection.rowHash.localeCompare(right.selection.rowHash)
  ));
  const maximumSettledRows = Number(options.maximumSettledRows || 0);
  const settled = maximumSettledRows > 0
    ? orderedSettled.slice(0, maximumSettledRows)
    : orderedSettled;
  const won = settled.filter((row) => row.settlement.outcome === "WON").length;
  const lost = settled.length - won;
  const interval = wilsonInterval(won, settled.length);
  const netUnits = settled.reduce((sum, row) => (
    sum + (row.settlement.outcome === "WON" ? (row.selection.oddsMilli / 1000) - 1 : -1)
  ), 0);
  const modelBrier = brierFor(settled, "modelProbabilitiesPpm");
  const marketBrier = brierFor(settled, "marketProbabilitiesPpm");
  const clvValues = settled.map((row) => {
    const value = finiteNumber(row.settlement.clvPpm, null);
    return value === null ? null : value / 1_000_000;
  })
    .filter((value) => value !== null);
  const leagueCounts = new Map();
  for (const row of settled) {
    const league = String(row.selection.leagueName || "unknown");
    leagueCounts.set(league, (leagueCounts.get(league) || 0) + 1);
  }
  const byLeague = Object.fromEntries(
    [...leagueCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])),
  );
  const kickoffTimes = settled.map((row) => parseTime(row.selection.kickoffAt)).filter(Number.isFinite);
  const spanDays = kickoffTimes.length > 1
    ? (Math.max(...kickoffTimes) - Math.min(...kickoffTimes)) / 86_400_000
    : 0;
  const timeWindows = buildStrictTimeWindows(
    settled,
    Number(options.minimumRowsPerWindow || GOODWIN_BENCHMARK_SHADOW_POLICY.minimumRowsPerWindow || 15),
  );
  const dueUniverses = universes.filter((event) => (
    parseTime(event?.decisionCutoffAt) <= parseTime(ledger?.updatedAt)
  ));
  const finalizedKeys = new Set([...selections, ...exclusions].map((event) => event.cohortKey));
  const dueWithoutDecision = dueUniverses.filter((event) => !finalizedKeys.has(event.cohortKey));
  const coverageGapRows = exclusions.filter((event) => event?.status === "coverage_gap").length;
  const identityConflictRows = universes.filter((event) => event?.identityConflictWith).length;
  const positiveClvRows = clvValues.filter((value) => value > 0).length;
  const timeIntegrityEvidenceRows = settled.filter((row) => (
    Number.isFinite(parseTime(row?.settlement?.actualKickoffAt))
    || Number.isFinite(parseTime(row?.settlement?.firstInPlayObservedAt))
  )).length;
  const brierSkillScore90LowerBound = bootstrapBrierSkillLower(settled);
  const absoluteSpiegelhalterZ = (() => {
    const value = spiegelhalterZ(settled);
    return value === null ? null : Math.abs(value);
  })();
  const roiReturns = settled.map((row) => (
    row.settlement.outcome === "WON" ? (row.selection.oddsMilli / 1000) - 1 : -1
  ));
  const roiMean = roiReturns.length
    ? roiReturns.reduce((sum, value) => sum + value, 0) / roiReturns.length
    : null;
  const roiVariance = roiReturns.length > 1
    ? roiReturns.reduce((sum, value) => sum + ((value - roiMean) ** 2), 0)
      / (roiReturns.length - 1)
    : null;
  const roi95LowerPercent = roiMean !== null && roiVariance !== null
    ? round((roiMean - (1.96 * Math.sqrt(roiVariance / roiReturns.length))) * 100, 2)
    : null;
  const maxWindowShare = settled.length && timeWindows.length
    ? Math.max(...timeWindows.map((window) => window.rows / settled.length))
    : null;
  return {
    cohort: {
      universe: universes.length,
      dueUniverse: dueUniverses.length,
      finalized: selections.length + exclusions.length,
      selected: selections.length,
      excluded: exclusions.length,
      coverageGap: coverageGapRows,
      identityConflicts: identityConflictRows,
      dueWithoutDecision: dueWithoutDecision.length,
      pending: joined.length - orderedSettled.length - voidRows.length,
      void: voidRows.length,
      settlementHolds: new Set(settlementHolds.map((event) => event.selectionHash)).size,
      settled: settled.length,
      won,
      lost,
    },
    metrics: {
      settled: settled.length,
      won,
      lost,
      hitRate: settled.length ? round(won / settled.length, 6) : null,
      hitRatePercent: settled.length ? round((won / settled.length) * 100, 2) : null,
      confidence95Percent: interval ? interval.map((value) => round(value * 100, 2)) : null,
      wilsonLowerBound: interval ? round(interval[0], 8) : null,
      averageOdds: settled.length
        ? round(
            settled.reduce((sum, row) => sum + (row.selection.oddsMilli / 1000), 0)
              / settled.length,
            4,
          )
        : null,
      netUnits: settled.length ? round(netUnits, 4) : null,
      roiPercent: settled.length ? round((netUnits / settled.length) * 100, 2) : null,
      modelBrier,
      marketBrier,
      brierSkillScore: modelBrier !== null && marketBrier > 0
        ? round(1 - (modelBrier / marketBrier), 8)
        : null,
      brierSkillScore90LowerBound,
      expectedCalibrationError: expectedCalibrationError(settled),
      spiegelhalterZ: spiegelhalterZ(settled),
      absoluteSpiegelhalterZ,
      closingLineRows: clvValues.length,
      closingLineCoverage: settled.length ? round(clvValues.length / settled.length, 6) : 0,
      medianClv: median(clvValues) === null ? null : round(median(clvValues), 8),
      positiveClvRows,
      positiveClvRate: clvValues.length ? round(positiveClvRows / clvValues.length, 6) : null,
      timeIntegrityEvidenceRows,
      timeIntegrityEvidenceCoverage: settled.length
        ? round(timeIntegrityEvidenceRows / settled.length, 6)
        : 0,
      spanDays: round(spanDays, 2),
      leagueCount: leagueCounts.size,
      maximumSingleLeagueShare: settled.length
        ? round(Math.max(0, ...leagueCounts.values()) / settled.length, 6)
        : null,
      maximumSingleWindowShare: maxWindowShare === null ? null : round(maxWindowShare, 6),
      roi95LowerPercent,
    },
    byLeague,
    timeWindows,
    joined,
  };
};

const blockerCounts = (ledger) => {
  const counts = new Map();
  for (const event of ledger.events.filter((row) => row?.type === "exclusion")) {
    for (const blocker of event.blockers || []) {
      counts.set(blocker, (counts.get(blocker) || 0) + 1);
    }
  }
  return Object.fromEntries(
    [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])),
  );
};

const gateChecksForSummary = (
  summary,
  policy = GOODWIN_BENCHMARK_SHADOW_POLICY,
  chainValid = true,
) => {
  const metrics = summary.metrics;
  const eligibleWindows = summary.timeWindows.filter((window) => window.eligible);
  return {
    chainValid: chainValid === true,
    universeReconciled: summary.cohort.dueWithoutDecision === 0,
    coverageGapFree: summary.cohort.coverageGap === 0,
    identityConflictFree: summary.cohort.identityConflicts === 0,
    settledRows: summary.cohort.settled >= policy.minimumSettledRowsForPromotionReview,
    calendarSpan: metrics.spanDays >= policy.minimumCalendarDays,
    chronologicalWindows: eligibleWindows.length >= policy.minimumChronologicalFolds,
    windowConcentration: metrics.maximumSingleWindowShare !== null
      && metrics.maximumSingleWindowShare <= policy.maximumSingleWindowShare,
    closingLineCoverage: metrics.closingLineCoverage >= policy.minimumClosingLineCoverage,
    positiveClvRate: metrics.positiveClvRate !== null
      && metrics.positiveClvRate > policy.minimumPositiveClvRate,
    timeIntegrityEvidence: metrics.timeIntegrityEvidenceCoverage
      >= MINIMUM_TIME_INTEGRITY_EVIDENCE_COVERAGE,
    brierSkillNonInferiority: metrics.brierSkillScore90LowerBound !== null
      && metrics.brierSkillScore90LowerBound > policy.minimumBrierSkillScore90LowerBound,
    probabilityCalibration: metrics.absoluteSpiegelhalterZ !== null
      && metrics.absoluteSpiegelhalterZ <= policy.maximumAbsoluteSpiegelhalterZ,
    leagueDiversity: metrics.leagueCount >= policy.minimumLeagueCount
      && metrics.maximumSingleLeagueShare !== null
      && metrics.maximumSingleLeagueShare <= policy.maximumSingleLeagueShare,
  };
};

const buildAudit = ({
  ledgerUpdate,
  researchAudit = null,
  evaluatedAt = new Date().toISOString(),
  policy = GOODWIN_BENCHMARK_SHADOW_POLICY,
} = {}) => {
  const ledger = ledgerUpdate?.ledger || createLedger(evaluatedAt, policy);
  const summary = metricsForLedger(ledger);
  const metrics = summary.metrics;
  const gateChecks = gateChecksForSummary(summary, policy, ledgerUpdate?.chainValid === true);
  const gateEvaluations = ledger.events.filter((event) => event?.type === "gate_evaluation");
  const latestGateEvaluation = gateEvaluations[gateEvaluations.length - 1] || null;
  const promotionReviewReady = latestGateEvaluation?.passed === true
    && latestGateEvaluation?.auditVersion === AUDIT_VERSION;
  const retrospectiveMetrics = researchAudit?.walkForward?.metrics || null;
  return {
    version: policy.version,
    auditVersion: AUDIT_VERSION,
    role: policy.role,
    status: promotionReviewReady ? "promotion-review-ready" : "collecting",
    activatedAt: policy.activatedAt,
    generatedAt: evaluatedAt,
    targetHitRate: policy.targetHitRate,
    criteria: {
      marketType: policy.marketType,
      oddsPoolCode: policy.oddsPoolCode,
      minimumEvidenceScore: policy.minimumEvidenceScore,
      evidenceScoreSource: "frozen BEST trustScore; policy-locked before prospective activation",
      minimumOdds: policy.minimumOdds,
      maximumOdds: policy.maximumOdds,
      decisionOffsetMinutes: policy.decisionOffsetMinutes,
      maximumSnapshotStalenessMinutes: policy.maximumSnapshotStalenessMinutes,
      maximumIngestLagMinutes: policy.maximumIngestLagMinutes,
      decisionSnapshotVersion: DECISION_SNAPSHOT_VERSION,
      cutoffSelectionRule: "evaluate-only-the-last-snapshot-before-the-fixed-cutoff; never search backward for a qualifying row",
      officialStrictMarketProvenanceRequired: true,
      capturedAndFirstSeenBeforeDeadlineRequired: true,
      timeIntegrityAuditVersion: TIME_INTEGRITY_AUDIT_VERSION,
      earlyActualKickoffOrLiveObservationPolicy: "void-when-not-after-decision-cutoff",
    },
    minimumSettledRowsForPromotionReview: policy.minimumSettledRowsForPromotionReview,
    minimumChronologicalFolds: policy.minimumChronologicalFolds,
    minimumCalendarDays: policy.minimumCalendarDays,
    gates: {
      thresholds: {
        reviewCheckpoints: [...policy.reviewCheckpoints],
        hitRateDisclosureOnly: true,
        minimumRowsPerWindow: policy.minimumRowsPerWindow,
        maximumSingleWindowShare: policy.maximumSingleWindowShare,
        maximumAbsoluteSpiegelhalterZ: policy.maximumAbsoluteSpiegelhalterZ,
        minimumBrierSkillScore90LowerBound: policy.minimumBrierSkillScore90LowerBound,
        minimumPositiveClvRate: policy.minimumPositiveClvRate,
        minimumClosingLineCoverage: policy.minimumClosingLineCoverage,
        minimumTimeIntegrityEvidenceCoverage: MINIMUM_TIME_INTEGRITY_EVIDENCE_COVERAGE,
        minimumLeagueCount: policy.minimumLeagueCount,
        maximumSingleLeagueShare: policy.maximumSingleLeagueShare,
        minimumRoiEvidenceRows: policy.minimumRoiEvidenceRows,
      },
      checks: gateChecks,
      evaluations: gateEvaluations.map((event) => ({
        checkpointN: event.checkpointN,
        auditVersion: event.auditVersion || null,
        evaluatedAt: event.recordedAt,
        passed: event.passed,
        datasetHash: event.datasetHash,
        rowHash: event.rowHash,
      })),
      latestEvaluation: latestGateEvaluation ? {
        checkpointN: latestGateEvaluation.checkpointN,
        auditVersion: latestGateEvaluation.auditVersion || null,
        evaluatedAt: latestGateEvaluation.recordedAt,
        passed: latestGateEvaluation.passed,
        datasetHash: latestGateEvaluation.datasetHash,
        rowHash: latestGateEvaluation.rowHash,
      } : null,
    },
    research: {
      scope: "2026 World Cup retrospective research-only holdout",
      source: researchAudit?.source || null,
      snapshotVersion: researchAudit?.snapshotVersion || null,
      snapshotGeneratedAt: researchAudit?.snapshotGeneratedAt || null,
      snapshotRowsSha256: researchAudit?.snapshotRowsSha256 || null,
      selectedRows: Number(researchAudit?.walkForward?.selectedRows || 0),
      foldCount: Number(researchAudit?.walkForward?.foldCount || 0),
      metrics: retrospectiveMetrics,
      promotionEligible: false,
      note: "Retrospective rows never enter the prospective or formal denominator.",
    },
    prospective: {
      ledgerVersion: LEDGER_VERSION,
      rootHash: ledger.rootHash,
      chainValid: ledgerUpdate?.chainValid === true,
      chainBlockers: ledgerUpdate?.blockers || [],
      eventCount: ledger.events.length,
      cohort: summary.cohort,
      metrics,
      timeWindows: summary.timeWindows.map((window) => ({ ...window })),
      byLeague: summary.byLeague,
      exclusionBlockers: blockerCounts(ledger),
    },
    walkForward: {
      protocol: "immutable-prospective-cross-league-ledger-v2",
      foldCount: summary.timeWindows.filter((window) => window.eligible).length,
      allFoldsStrictTimeOrder: summary.timeWindows.every((window, index, windows) => (
        index === 0 || parseTime(windows[index - 1].endAt) <= parseTime(window.startAt)
      )),
      evaluationRows: summary.cohort.finalized,
      selectedRows: summary.cohort.settled,
      coveragePercent: summary.cohort.finalized
        ? round((summary.cohort.selected / summary.cohort.finalized) * 100, 2)
        : 0,
      metrics,
      baselineMetrics: null,
      improvingFolds: 0,
    },
    promotionReviewReady,
    formalOnlineEffect: false,
    reason: promotionReviewReady
      ? "A preregistered checkpoint passed every process, calibration, CLV and composition gate; activation still requires independent human and global model-governance review."
      : "Collecting immutable post-activation samples; hit rate is disclosure-only, and review runs only at preregistered checkpoints.",
  };
};

const buildBenchmarkProspectiveAudit = (options = {}) => {
  const ledgerUpdate = updateLedger(options);
  return {
    ledgerUpdate,
    audit: buildAudit({
      ledgerUpdate,
      researchAudit: options.researchAudit,
      evaluatedAt: options.evaluatedAt,
      policy: options.policy,
    }),
  };
};

module.exports = {
  LEDGER_VERSION,
  AUDIT_VERSION,
  DECISION_SNAPSHOT_VERSION,
  GENESIS_HASH,
  parseTime,
  canonicalize,
  sha256,
  decisionCutoffFor,
  cohortKeyFor,
  canonicalEventKeyFor,
  buildSnapshotDecision,
  verifyLedger,
  createLedger,
  appendEvent,
  selectCutoffSnapshot,
  selectClosingOdds,
  resultDecision,
  updateLedger,
  wilsonInterval,
  metricsForLedger,
  buildAudit,
  buildBenchmarkProspectiveAudit,
};
