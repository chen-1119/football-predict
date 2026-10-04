const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  PAIR_VERSION, selectedEventPairForDecision, summarizePairedSelectedEvents,
} = require("./recommendationPairedEventScoring.cjs");
const {
  buildCandidateDecisionSnapshot, isDecisionClockAuditEligible,
  replayCandidateEvidence, settleDecisionCandidate,
} = require("../src/services/decisionSnapshot.cjs");
const { createCollectorAttestationTestContext } = require("./collectorAttestationTestFixture.cjs");
const clone = (value) => JSON.parse(JSON.stringify(value));

// Synthetic scores test comparison semantics only; the separate signed fixture
// below verifies real constructor -> clock audit -> replay -> settlement wiring.
const scoringRow = (index, selected = true, marketProbability = 0.7) => {
  const kickoffTime = new Date(Date.UTC(2026, 6, 1) + index * 3600000).toISOString();
  const decisionAt = new Date(Date.parse(kickoffTime) - 3600000).toISOString();
  const row = {
    matchId: `paired-${index}`, sourceMatchId: `provider-${index}`, kickoffTime,
    forecastTime: decisionAt, oddsPoolCode: index % 2 ? "HHAD" : "HAD",
    handicapLine: index % 2 ? -1 : null, tipCode: "1", outcomeCode: selected ? "1" : "2",
    odds: selected ? 2.35 : 1.8, won: selected,
    modelPickProbability: selected ? 0.8 : 0.6, marketPickProbability: marketProbability,
    decisionSnapshotVersion: "candidate-decision-snapshot-v2",
    oddsSource: "candidate-decision-snapshot:fixture", localEvidenceEligible: selected,
    productionPolicyReplay: true, promotionCohortEligible: true,
    resultObservationPromotionEligible: true,
  };
  const event = { matchId: row.matchId, sourceMatchId: row.sourceMatchId, decisionAt,
    pool: row.oddsPoolCode, line: row.handicapLine ?? 0, tipCode: row.tipCode,
    outcomeCode: row.outcomeCode };
  row.selectedEventPair = {
    version: PAIR_VERSION, snapshotVersion: row.decisionSnapshotVersion,
    clockAuditEligible: true, policyReplayExact: true,
    capturedAt: decisionAt, cutoffTime: decisionAt, kickoffTime,
    modelGeneratedAt: decisionAt, marketObservedAt: decisionAt, marketReceivedAt: decisionAt,
    sourceCycleId: "paired-fixture", policyHash: "a".repeat(64), marketProvenanceHash: "b".repeat(64),
    resultObservedAt: new Date(Date.parse(kickoffTime) + 7200000).toISOString(),
    modelEvent: { ...event }, marketEvent: { ...event },
    modelProbability: row.modelPickProbability, marketProbability: row.marketPickProbability, won: row.won,
  };
  return row;
};

const realDecisionFixture = () => {
  const context = createCollectorAttestationTestContext({ keyId: "paired-scoring-test-ed25519" });
  const cycle = "paired-real-cycle";
  const provenance = (pool) => context.buildSignedMarketProvenance({
    poolCode: pool, sourceMatchId: "paired-real", handicapLine: pool === "HHAD" ? -1 : 0,
    odds: pool === "HAD" ? { "1": 1.9, X: 3.3, "2": 4.1 } : { "1": 2.8, X: 3.25, "2": 2.1 },
    sourceUrl: "https://webapi.sporttery.cn/test",
    providerObservedAt: "2026-07-16T10:25:00.000Z",
    sourceTiming: { sourceCycleId: cycle, requestedAt: "2026-07-16T10:24:00.000Z",
      receivedAt: "2026-07-16T10:26:00.000Z", sourceRequest: { method: "GET", role: "paired-fixture" },
      httpStatus: 200, rawSha256: "c".repeat(64), rawBytes: 1024 },
  });
  const match = {
    id: "sporttery_paired-real", sourceMatchId: "paired-real",
    kickoffTime: "2026-07-16T12:00:00.000Z", buyEndTime: "2026-07-16T11:50:00.000Z",
    odds: { odds1: 1.9, oddsX: 3.3, odds2: 4.1 }, oddsMarketProvenance: provenance("HAD"),
    handicapLine: "-1", handicapOdds: { odds1: 2.8, oddsX: 3.25, odds2: 2.1 },
    handicapOddsMarketProvenance: provenance("HHAD"),
    predictionMeta: { generatedAt: "2026-07-16T10:40:00.000Z", decisionGeneratedAt: "2026-07-16T10:40:00.000Z",
      sourceCycleId: cycle, cutoffTime: "2026-07-16T11:50:00.000Z" },
    probabilityModel: { generatedAt: "2026-07-16T10:37:00.000Z",
      oneXTwo: { final: { home: 52, draw: 28, away: 20 } },
      handicap: { line: "-1", unifiedPosterior: { home: 31, draw: 42, away: 27 } },
      unifiedPosterior: { generatedAt: "2026-07-16T10:39:00.000Z", selectedMarket: "HAD", selectedCode: "1",
        dataQuality: 0.8, candidates: [{ market: "HAD", code: "1", probability: 52, odds: 1.9 },
          { market: "HHAD", code: "X", probability: 42, odds: 3.25 }] } },
  };
  const decision = buildCandidateDecisionSnapshot(match, "2026-07-16T10:20:00.000Z");
  const rows = decision.candidates.map((candidate) => {
    const replay = replayCandidateEvidence(decision, candidate);
    const row = { matchId: match.id, sourceMatchId: match.sourceMatchId, kickoffTime: match.kickoffTime,
      forecastTime: decision.capturedAt, oddsPoolCode: candidate.market, handicapLine: candidate.handicapLine,
      tipCode: candidate.code, modelPickProbability: candidate.modelProbability,
      marketPickProbability: candidate.marketProbability, decisionSnapshotVersion: decision.version,
      promotionCohortEligible: isDecisionClockAuditEligible(decision), productionPolicyReplay: replay.exact,
      resultObservationPromotionEligible: true, ...settleDecisionCandidate(candidate, 2, 1) };
    row.selectedEventPair = selectedEventPairForDecision(row, decision, "2026-07-16T14:00:00.000Z");
    return row;
  });
  return { context, decision, rows };
};

const runPairedEventScoringChecks = (compareSelection = null) => {
  const checks = [];
  const check = (name, ok, details) => checks.push({ name, ok: Boolean(ok), ...(details ? { details } : {}) });
  const row = scoringRow(0);
  const valid = summarizePairedSelectedEvents([row]);
  check("same event binary model/market scoring", valid.complete && valid.scoring === "binary-selected-event"
    && valid.model.brier === 0.04 && valid.market.brier === 0.09);
  const empty = summarizePairedSelectedEvents([]);
  check("no pairs explicitly unavailable with null scores", empty.status === "unavailable"
    && empty.model.brier === null && empty.relativeToMarket.logLossImprovement === null);
  for (const value of [null, "0.8", true, -0.1, 1.1, NaN]) {
    const invalid = clone(row); invalid.modelPickProbability = value;
    check(`probability rejects ${String(value)}`, summarizePairedSelectedEvents([invalid]).pairedRows === 0);
  }
  for (const [name, mutate] of [
    ["decision time mismatch", (copy) => { copy.selectedEventPair.marketEvent.decisionAt = "2026-07-01T00:30:00.000Z"; }],
    ["HHAD line mismatch", (copy) => { copy.selectedEventPair.marketEvent.line = 1; }],
    ["outcome conflict", (copy) => { copy.won = false; }],
    ["missing replay", (copy) => { copy.productionPolicyReplay = false; }],
    ["missing clock audit", (copy) => { copy.selectedEventPair.clockAuditEligible = false; }],
    ["missing provenance", (copy) => { copy.selectedEventPair.marketProvenanceHash = null; }],
    ["timezone missing", (copy) => { copy.selectedEventPair.modelGeneratedAt = "2026-06-30T23:00:00"; }],
    ["nonexistent calendar date", (copy) => { copy.selectedEventPair.modelGeneratedAt = "2026-02-30T23:00:00.000Z"; }],
  ]) {
    const invalid = scoringRow(1); mutate(invalid);
    check(name, summarizePairedSelectedEvents([invalid]).pairedRows === 0);
  }
  const duplicates = summarizePairedSelectedEvents([row, clone(row)]);
  check("identical event duplicates do not inflate samples", duplicates.pairedRows === 1 && duplicates.duplicateRows === 1);
  const conflict = clone(row); conflict.marketPickProbability = 0.9; conflict.selectedEventPair.marketProbability = 0.9;
  const conflicted = summarizePairedSelectedEvents([row, conflict]);
  check("conflicting duplicate excludes the whole event", conflicted.pairedRows === 0 && conflicted.conflictingEvents === 1);
  const invalidSingleton = clone(row); invalidSingleton.productionPolicyReplay = false;
  const invalidOnly = summarizePairedSelectedEvents([invalidSingleton]);
  check("invalid singleton is rejected without inventing an event conflict", invalidOnly.pairedRows === 0
    && invalidOnly.invalidRows === 1 && invalidOnly.conflictingEvents === 0 && invalidOnly.taintedEvents === 0
    && invalidOnly.exclusions["pair-promotion-evidence-ineligible"] === 1
    && invalidOnly.exclusions["pair-conflicting-event"] === undefined);
  const tainted = summarizePairedSelectedEvents([row, invalidSingleton]);
  check("invalid plus valid counterpart is separately tainted and fail closed", tainted.pairedRows === 0
    && tainted.invalidRows === 1 && tainted.conflictingEvents === 0 && tainted.taintedEvents === 1
    && tainted.exclusions["pair-tainted-event"] === 1);
  const otherMatch = clone(row); otherMatch.matchId = "other-real-match";
  otherMatch.selectedEventPair.modelEvent.matchId = otherMatch.matchId;
  otherMatch.selectedEventPair.marketEvent.matchId = otherMatch.matchId;
  check("reused provider ID does not join different matches", summarizePairedSelectedEvents([row, otherMatch]).pairedRows === 2);
  const real = realDecisionFixture();
  const realScores = summarizePairedSelectedEvents(real.rows);
  check("real signed v2 constructor/replay/settler accepts HAD and HHAD", isDecisionClockAuditEligible(real.decision)
    && realScores.pairedRows === 2 && realScores.complete
    && real.rows.find((entry) => entry.oddsPoolCode === "HHAD").handicapLine === -1, realScores);
  const brokenDecision = clone(real.decision); delete brokenDecision.clockAudit;
  const brokenRow = clone(real.rows[0]);
  brokenRow.selectedEventPair = selectedEventPairForDecision(brokenRow, brokenDecision, "2026-07-16T14:00:00.000Z");
  check("manually asserted row eligibility cannot bypass real snapshot clock audit",
    summarizePairedSelectedEvents([brokenRow]).pairedRows === 0);
  real.context.cleanup();
  if (compareSelection) {
    const rows = Array.from({ length: 500 }, (_, index) => scoringRow(index, index % 5 < 3));
    const report = compareSelection(rows, rows);
    check("actual comparison keeps original cohorts and pairs model/market per cohort",
      report.before.settled === 500 && report.after.settled === 300 && report.spOnlyBaseline.settled === 200
      && report.pairedSelectedEventComparison.candidate.pairedRows === 300
      && report.gate.pairedSamplesComplete && report.gate.eligible);
    const noEvidence = rows.map(({ selectedEventPair, ...entry }) => entry);
    const missing = compareSelection(noEvidence, noEvidence);
    check("missing pairing retains descriptive stats but cannot activate", missing.before.settled === report.before.settled
      && missing.after.settled === report.after.settled && missing.gate.eligible === false
      && missing.pairedSelectedEventComparison.candidate.status === "unavailable");
    const marketBetterRows = rows.map((entry) => {
      const copy = clone(entry);
      if (copy.localEvidenceEligible) {
        copy.marketPickProbability = 0.9; copy.selectedEventPair.marketProbability = 0.9;
      }
      return copy;
    });
    const worse = compareSelection(marketBetterRows, marketBetterRows);
    check("cross-subset score advantage cannot mask inferior same-event model scoring",
      worse.gate.modelBrierNonWorse && worse.gate.modelLogLossNonWorse
      && !worse.gate.pairedModelBrierNonWorse && !worse.gate.pairedModelLogLossNonWorse && !worse.gate.eligible);
    const reversed = compareSelection([...rows].reverse(), [...rows].reverse());
    check("pair set and scoring independent of input order", JSON.stringify(report.pairedSelectedEventComparison)
      === JSON.stringify(reversed.pairedSelectedEventComparison));
  }
  const backtest = path.join(__dirname, "runModelBacktest.cjs");
  for (const [name, output] of [["input override requires isolated output", null],
    ["output cannot be inside input directory", path.join(__dirname, "model-evaluation-test.json")]]) {
    const env = { ...process.env, MODEL_BACKTEST_INPUT_DATA_DIR: __dirname };
    if (output) env.MODEL_BACKTEST_PUBLIC_OUTPUT_FILE = output;
    else delete env.MODEL_BACKTEST_PUBLIC_OUTPUT_FILE;
    const rejected = spawnSync(process.execPath, [backtest, "--verify-recommendation-selection-time-order"], { env, encoding: "utf8" });
    check(name, rejected.status !== 0 && /requires an explicit isolated|overlaps a read-only input/.test(rejected.stderr));
  }
  return { ok: checks.every((entry) => entry.ok), verifier: "recommendation-paired-selected-event-scoring",
    assertions: checks.length, integrationExecuted: Boolean(compareSelection), checks };
};

module.exports = { runPairedEventScoringChecks };
if (require.main === module) {
  const { recommendationSelectionComparison } = require("./runModelBacktest.cjs");
  const result = runPairedEventScoringChecks(recommendationSelectionComparison);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}
