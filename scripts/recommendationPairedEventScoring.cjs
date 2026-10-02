const crypto = require("node:crypto");
const { isDecisionClockAuditEligible } = require("../src/services/decisionSnapshot.cjs");

const PAIR_VERSION = "immutable-selected-event-pair-v1";
const SNAPSHOT_VERSION = "candidate-decision-snapshot-v2";
const epoch = (value) => {
  if (typeof value !== "string") return null;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts) return null;
  const calendar = new Date(Date.UTC(...[Number(parts[1]), Number(parts[2]) - 1,
    Number(parts[3]), Number(parts[4]), Number(parts[5]), Number(parts[6])]));
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 19) !== value.slice(0, 19)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
};
const probability = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const text = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
const round = (value) => Number.isFinite(value) ? Number(value.toFixed(6)) : null;
const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

// The envelope is derived only where an immutable candidate is settled. It is
// never inferred from the latest model, a legacy publication or fallback odds.
const selectedEventPairForDecision = (row, snapshot, resultObservedAt) => {
  const market = snapshot?.markets?.[row.oddsPoolCode];
  const event = {
    matchId: row.matchId,
    sourceMatchId: row.sourceMatchId,
    decisionAt: snapshot?.decisionAt,
    pool: row.oddsPoolCode,
    line: row.oddsPoolCode === "HHAD" ? row.handicapLine : 0,
    tipCode: row.tipCode,
    outcomeCode: row.outcomeCode,
  };
  return {
    version: PAIR_VERSION,
    snapshotVersion: snapshot?.version,
    clockAuditEligible: row.promotionCohortEligible === true && isDecisionClockAuditEligible(snapshot),
    policyReplayExact: row.productionPolicyReplay === true,
    capturedAt: snapshot?.capturedAt,
    cutoffTime: snapshot?.cutoffTime,
    kickoffTime: snapshot?.kickoffTime,
    modelGeneratedAt: snapshot?.clockAudit?.modelGeneratedAt,
    marketObservedAt: market?.observedAt,
    marketReceivedAt: market?.receivedAt,
    sourceCycleId: snapshot?.sourceCycleId,
    marketProvenanceHash: market?.provenanceHash,
    policyHash: snapshot?.policyHash,
    resultObservedAt,
    modelEvent: { ...event },
    marketEvent: { ...event },
    modelProbability: row.modelPickProbability,
    marketProbability: row.marketPickProbability,
    won: row.won,
  };
};

const validatePair = (row) => {
  const pair = row?.selectedEventPair;
  const blockers = [];
  if (!pair || pair.version !== PAIR_VERSION) return { blockers: ["pair-evidence-missing"], key: null };
  if (pair.snapshotVersion !== SNAPSHOT_VERSION || row.decisionSnapshotVersion !== SNAPSHOT_VERSION) {
    blockers.push("pair-snapshot-version-ineligible");
  }
  if (pair.clockAuditEligible !== true || pair.policyReplayExact !== true
      || row.promotionCohortEligible !== true || row.productionPolicyReplay !== true
      || row.resultObservationPromotionEligible !== true) blockers.push("pair-promotion-evidence-ineligible");
  const expected = {
    matchId: row.matchId, sourceMatchId: row.sourceMatchId,
    decisionAt: pair.modelEvent?.decisionAt, pool: row.oddsPoolCode,
    line: row.oddsPoolCode === "HHAD" ? row.handicapLine : 0,
    tipCode: row.tipCode, outcomeCode: row.outcomeCode,
  };
  const eventFields = ["matchId", "sourceMatchId", "decisionAt", "pool", "line", "tipCode", "outcomeCode"];
  if (!text(String(expected.matchId ?? "")) || !text(String(expected.sourceMatchId ?? ""))
      || !["HAD", "HHAD"].includes(expected.pool)
      || !["1", "X", "2"].includes(expected.tipCode)
      || !["1", "X", "2"].includes(expected.outcomeCode)
      || typeof expected.line !== "number" || !Number.isFinite(expected.line)
      || eventFields.some((field) => pair.modelEvent?.[field] !== expected[field]
        || pair.marketEvent?.[field] !== expected[field])) blockers.push("pair-event-identity-mismatch");
  if (typeof row.won !== "boolean" || pair.won !== row.won
      || row.won !== (expected.tipCode === expected.outcomeCode)) blockers.push("pair-result-event-mismatch");
  if (!probability(row.modelPickProbability) || !probability(row.marketPickProbability)
      || pair.modelProbability !== row.modelPickProbability
      || pair.marketProbability !== row.marketPickProbability) blockers.push("pair-probability-invalid");
  const captured = epoch(pair.capturedAt);
  const decision = epoch(expected.decisionAt);
  const cutoff = epoch(pair.cutoffTime);
  const kickoff = epoch(pair.kickoffTime);
  const model = epoch(pair.modelGeneratedAt);
  const observed = epoch(pair.marketObservedAt);
  const received = epoch(pair.marketReceivedAt);
  const result = epoch(pair.resultObservedAt);
  if ([captured, decision, cutoff, kickoff, model, observed, received, result].some((time) => time === null)
      || captured > decision || decision > cutoff || cutoff > kickoff
      || model > decision || observed > received || received > decision || result < kickoff
      || epoch(row.forecastTime) !== captured || epoch(row.kickoffTime) !== kickoff) {
    blockers.push("pair-clock-invalid");
  }
  if (!text(pair.sourceCycleId) || !/^[a-f\d]{64}$/i.test(pair.policyHash || "")
      || !/^[a-f\d]{64}$/i.test(pair.marketProvenanceHash || "")) blockers.push("pair-provenance-missing");
  return {
    blockers,
    // Outcome is deliberately excluded from the key: contradictory results for
    // the same selected event must conflict, rather than become two samples.
    key: hash([String(expected.matchId), String(expected.sourceMatchId), decision,
      expected.pool, expected.line, expected.tipCode]),
    signature: hash([expected, pair.modelProbability, pair.marketProbability, pair.won,
      captured, cutoff, kickoff, model, observed, received, result,
      pair.sourceCycleId, pair.policyHash, pair.marketProvenanceHash]),
    pair,
  };
};

const score = (pairs, key) => {
  if (!pairs.length) return { rows: 0, brier: null, logLoss: null };
  let brier = 0;
  let logLoss = 0;
  for (const pair of pairs) {
    const target = pair.won ? 1 : 0;
    const value = pair[key];
    const bounded = Math.max(1e-12, Math.min(1 - 1e-12, value));
    brier += (value - target) ** 2;
    logLoss -= target * Math.log(bounded) + (1 - target) * Math.log(1 - bounded);
  }
  return { rows: pairs.length, brier: round(brier / pairs.length), logLoss: round(logLoss / pairs.length) };
};

const summarizePairedSelectedEvents = (rows) => {
  const groups = new Map();
  const exclusions = {};
  let invalidRows = 0;
  for (const row of rows) {
    const entry = validatePair(row);
    if (entry.blockers.length) {
      invalidRows += 1;
      for (const blocker of entry.blockers) exclusions[blocker] = (exclusions[blocker] || 0) + 1;
      // An invalid copy with an identifiable key taints its valid counterpart.
      if (entry.key) {
        const group = groups.get(entry.key) || { signatures: new Map(), tainted: false, rows: 0 };
        group.tainted = true;
        group.rows += 1;
        groups.set(entry.key, group);
      }
      continue;
    }
    const group = groups.get(entry.key) || { signatures: new Map(), tainted: false, rows: 0 };
    group.rows += 1;
    group.signatures.set(entry.signature, entry.pair);
    groups.set(entry.key, group);
  }
  const pairs = [];
  const pairKeys = [];
  let conflictingEvents = 0;
  let taintedEvents = 0;
  let duplicateRows = 0;
  for (const [key, group] of groups) {
    if (group.signatures.size > 1) { conflictingEvents += 1; continue; }
    if (group.tainted) {
      if (group.signatures.size > 0) taintedEvents += 1;
      continue;
    }
    if (group.signatures.size === 1) {
      pairs.push(group.signatures.values().next().value);
      pairKeys.push(key);
      duplicateRows += group.rows - 1;
    }
  }
  if (conflictingEvents) exclusions["pair-conflicting-event"] = conflictingEvents;
  if (taintedEvents) exclusions["pair-tainted-event"] = taintedEvents;
  const model = score(pairs, "modelProbability");
  const market = score(pairs, "marketProbability");
  const complete = pairs.length > 0 && invalidRows === 0 && conflictingEvents === 0;
  return {
    version: PAIR_VERSION,
    scoring: "binary-selected-event",
    status: !pairs.length ? "unavailable" : complete ? "available" : "shadow-incomplete",
    sourceRows: rows.length,
    pairedRows: pairs.length,
    duplicateRows,
    invalidRows,
    conflictingEvents,
    taintedEvents,
    complete,
    coverage: rows.length ? round(pairs.length / (rows.length - duplicateRows)) : 0,
    model,
    market,
    relativeToMarket: {
      brierImprovement: pairs.length ? round(market.brier - model.brier) : null,
      logLossImprovement: pairs.length ? round(market.logLoss - model.logLoss) : null,
    },
    exclusions,
    pairSetHash: pairs.length ? hash(pairKeys.sort()) : null,
    policy: "Same match, immutable v2 decision time, pool/line/direction and settled result event; binary selected-event scores, never a three-class HAD score. Missing clocks, replay or provenance remain shadow.",
  };
};

module.exports = { PAIR_VERSION, selectedEventPairForDecision, summarizePairedSelectedEvents };
