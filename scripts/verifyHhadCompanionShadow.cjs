const assert = require("node:assert/strict");
const {
  HHAD_COMPANION_SHADOW_VERSION,
  STRATEGY_HASH,
  canonicalStringify,
  evaluateHhadCompanionShadow,
  settleHhadCompanionShadow,
} = require("../src/services/hhadCompanionShadow.cjs");

const beforeCutoff = {
  cutoffTime: "2026-07-12T04:50:00.000Z",
  capturedAt: "2026-07-12T03:30:00.000Z",
  receivedAt: "2026-07-12T03:31:00.000Z",
  observedAt: "2026-07-12T03:29:00.000Z",
  sourceRevision: "korea-screenshot-v1",
  sourceSnapshotHash: "fixture-snapshot",
  modelVersion: "unified-posterior-v60",
  modelGeneratedAt: "2026-07-12T03:28:00.000Z",
  unifiedPosteriorGeneratedAt: "2026-07-12T03:28:30.000Z",
  decisionAt: "2026-07-12T03:30:00.000Z",
  featureSnapshotCapturedAt: "2026-07-12T03:27:00.000Z",
};

const fixtures = [
  {
    name: "Korea 201",
    input: {
      ...beforeCutoff,
      matchId: "sporttery-20260712-201",
      handicapLine: "-1",
      modelHandicapLine: -1,
      odds: { home: 4.28, draw: 3.45, away: 1.65 },
      modelProbabilities: { home: 0.22, draw: 0.242, away: 0.538 },
      best: { oddsPoolCode: "HHAD", tipCode: "2", handicapLine: "-1" },
    },
    expected: { code: "2", outcome: "AWAY", line: -1, odds: 1.65 },
  },
  {
    name: "Korea 202",
    input: {
      ...beforeCutoff,
      matchId: "sporttery-20260712-202",
      handicapLine: "+1",
      modelHandicapLine: "+1",
      odds: { odds1: 1.53, oddsX: 3.68, odds2: 4.9 },
      modelProbabilities: { "1": 75.5, X: 13.5, "2": 11 },
      best: { oddsPoolCode: "HHAD", tipCode: "1", handicapLine: "+1" },
    },
    expected: { code: "1", outcome: "HOME", line: 1, odds: 1.53 },
  },
  {
    name: "Korea 203",
    input: {
      ...beforeCutoff,
      matchId: "sporttery-20260712-203",
      handicapLine: -1,
      modelHandicapLine: "HHAD -1",
      odds: { "1": 5.65, X: 3.75, "2": 1.46 },
      modelProbabilities: { home: 0.19, draw: 0.275, away: 0.535 },
      best: { oddsPoolCode: "HAD", tipCode: "1" },
    },
    expected: { code: "2", outcome: "AWAY", line: -1, odds: 1.46 },
  },
];

const evaluated = fixtures.map((fixture) => {
  const exposure = evaluateHhadCompanionShadow(fixture.input);
  assert.equal(exposure.version, HHAD_COMPANION_SHADOW_VERSION, `${fixture.name}: version`);
  assert.equal(exposure.action, "EVALUATE", `${fixture.name}: must enter shadow evaluation`);
  assert.deepEqual(exposure.blockers, [], `${fixture.name}: no blocker expected`);
  assert.equal(exposure.selection.code, fixture.expected.code, `${fixture.name}: model top code`);
  assert.equal(exposure.selection.outcome, fixture.expected.outcome, `${fixture.name}: model top outcome`);
  assert.equal(exposure.selection.handicapLine, fixture.expected.line, `${fixture.name}: exact frozen line`);
  assert.equal(exposure.selection.odds, fixture.expected.odds, `${fixture.name}: selected official SP`);
  assert.equal(exposure.diagnostics.usedMarketFallback, false, `${fixture.name}: no market fallback`);
  for (const hash of Object.values(exposure.hashes)) assert.match(hash, /^[a-f0-9]{64}$/);
  return exposure;
});

assert.equal(evaluated[2].diagnostics.best.conflict, true, "203 HAD home BEST conflict is diagnostic");
assert.equal(evaluated[2].diagnostics.bestConflictIsBlocker, false, "BEST conflict is never a blocker");
assert.equal(evaluated[2].action, "EVALUATE", "BEST conflict must not change shadow action");
assert.equal(evaluated[0].cohortHash, evaluated[2].cohortHash, "same policy/line/direction belongs to the same cohort");
assert.notEqual(evaluated[0].revisionHash, evaluated[2].revisionHash, "different matches retain distinct source revisions");

const koreaSettlements = [
  settleHhadCompanionShadow(evaluated[0], { scoreHome: 0, scoreAway: 1 }),
  settleHhadCompanionShadow(evaluated[1], { scoreHome: 0, scoreAway: 0 }),
  settleHhadCompanionShadow(evaluated[2], { scoreHome: 0, scoreAway: 0 }),
];
assert.deepEqual(koreaSettlements.map((row) => row.status), ["WON", "WON", "WON"], "the three frozen screenshot fixtures settle independently as won");

const reordered201 = evaluateHhadCompanionShadow({
  best: { handicapLine: -1, tipCode: "away", oddsPoolCode: "HHAD" },
  modelProbabilities: { away: 0.538, home: 0.22, draw: 0.242 },
  odds: { away: 1.65, home: 4.28, draw: 3.45 },
  modelHandicapLine: "-1",
  handicapLine: -1,
  modelVersion: "unified-posterior-v60",
  modelGeneratedAt: "2026-07-12T11:28:00+08:00",
  unifiedPosteriorGeneratedAt: "2026-07-12T11:28:30+08:00",
  decisionAt: "2026-07-12T11:30:00+08:00",
  featureSnapshotCapturedAt: "2026-07-12T11:27:00+08:00",
  sourceSnapshotHash: "fixture-snapshot",
  sourceRevision: "korea-screenshot-v1",
  observedAt: "2026-07-12T11:29:00+08:00",
  receivedAt: "2026-07-12T11:31:00+08:00",
  capturedAt: "2026-07-12T11:30:00+08:00",
  cutoffTime: "2026-07-12T12:50:00+08:00",
  matchId: "sporttery-20260712-201",
});
assert.deepEqual(reordered201.hashes, evaluated[0].hashes, "key order, aliases, and equivalent time zones must not alter hashes");
assert.equal(canonicalStringify({ b: 2, a: 1 }), canonicalStringify({ a: 1, b: 2 }), "canonical serialization sorts keys");
assert.equal(evaluated[0].strategyHash, STRATEGY_HASH, "strategy hash is policy-only");

const changedBest201 = evaluateHhadCompanionShadow({
  ...fixtures[0].input,
  best: { oddsPoolCode: "HAD", tipCode: "1" },
});
assert.equal(changedBest201.exposureHash, evaluated[0].exposureHash, "public BEST cannot rewrite the shadow exposure");
assert.notEqual(changedBest201.pairHash, evaluated[0].pairHash, "paired-comparison identity must track public BEST revision");
assert.equal(changedBest201.action, "EVALUATE", "BEST conflict is diagnostic only");

const missingOptionalModelTimes = evaluateHhadCompanionShadow({
  ...fixtures[0].input,
  modelGeneratedAt: undefined,
  unifiedPosteriorGeneratedAt: undefined,
  decisionAt: undefined,
  featureSnapshotCapturedAt: undefined,
});
assert.equal(missingOptionalModelTimes.action, "EVALUATE", "missing legacy model times remain compatible");
assert.deepEqual(missingOptionalModelTimes.blockers, []);

const blockerCases = [
  ["missing exact model line", { ...fixtures[0].input, modelHandicapLine: undefined }, "missing-model-hhad-line"],
  ["line mismatch", { ...fixtures[0].input, modelHandicapLine: "+1" }, "hhad-line-mismatch"],
  ["line too small", { ...fixtures[0].input, handicapLine: "+0.25", modelHandicapLine: 0.25 }, "handicap-magnitude-below-threshold"],
  ["missing one official odd", { ...fixtures[0].input, odds: { home: 4.28, away: 1.65 } }, "incomplete-or-invalid-official-odds"],
  ["missing one model probability", { ...fixtures[0].input, modelProbabilities: { home: 0.22, away: 0.78 } }, "incomplete-or-invalid-model-probabilities"],
  ["model probability", { ...fixtures[0].input, modelProbabilities: { home: 0.3, draw: 0.25, away: 0.45 } }, "model-probability-below-threshold"],
  ["thin model gap", { ...fixtures[0].input, modelProbabilities: { home: 0.3, draw: 0.33, away: 0.37 } }, "model-gap-below-threshold"],
  ["market leader mismatch", { ...fixtures[0].input, odds: { home: 1.65, draw: 3.45, away: 4.28 } }, "model-market-leader-misaligned"],
  ["market support", { ...fixtures[0].input, odds: { home: 1.5, draw: 3.1, away: 3.15 } }, "market-support-below-threshold"],
  ["captured after cutoff", { ...fixtures[0].input, capturedAt: "2026-07-12T04:50:00.001Z" }, "captured-after-cutoff"],
  ["received after cutoff", { ...fixtures[0].input, receivedAt: "2026-07-12T04:50:00.001Z" }, "received-after-cutoff"],
  ["observed after cutoff", { ...fixtures[0].input, observedAt: "2026-07-12T04:50:00.001Z" }, "observed-after-cutoff"],
  ["model generated after cutoff", { ...fixtures[0].input, modelGeneratedAt: "2026-07-12T04:50:00.001Z" }, "model-generated-after-cutoff"],
  ["invalid model generated time", { ...fixtures[0].input, modelGeneratedAt: "not-a-time" }, "invalid-model-generated-at"],
  ["unified posterior after cutoff", { ...fixtures[0].input, unifiedPosteriorGeneratedAt: "2026-07-12T04:50:00.001Z" }, "unified-posterior-generated-after-cutoff"],
  ["invalid unified posterior time", { ...fixtures[0].input, unifiedPosteriorGeneratedAt: "not-a-time" }, "invalid-unified-posterior-generated-at"],
  ["decision after cutoff", { ...fixtures[0].input, decisionAt: "2026-07-12T04:50:00.001Z" }, "decision-after-cutoff"],
  ["invalid decision time", { ...fixtures[0].input, decisionAt: "not-a-time" }, "invalid-decision-at"],
  ["feature snapshot after cutoff", { ...fixtures[0].input, featureSnapshotCapturedAt: "2026-07-12T04:50:00.001Z" }, "feature-snapshot-captured-after-cutoff"],
  ["invalid feature snapshot time", { ...fixtures[0].input, featureSnapshotCapturedAt: "not-a-time" }, "invalid-feature-snapshot-captured-at"],
];

for (const [name, input, expectedBlocker] of blockerCases) {
  const exposure = evaluateHhadCompanionShadow(input);
  assert.equal(exposure.action, "SKIP", `${name}: blocker must fail closed`);
  assert.ok(exposure.blockers.includes(expectedBlocker), `${name}: expected ${expectedBlocker}`);
}

const won = settleHhadCompanionShadow(evaluated[0], { scoreHome: 0, scoreAway: 1, handicapLine: "+1", odds: 99 });
assert.equal(won.status, "WON");
assert.equal(won.outcomeCode, "2");
assert.deepEqual(won.frozen, { poolCode: "HHAD", code: "2", handicapLine: -1, odds: 1.65 });
assert.equal(won.profitUnits, 0.65);

const lost = settleHhadCompanionShadow(evaluated[0], { scoreHome: 2, scoreAway: 0 });
assert.equal(lost.status, "LOST");
assert.equal(lost.outcomeCode, "1");
assert.equal(lost.profitUnits, -1);

const voided = settleHhadCompanionShadow(evaluated[0], { status: "CANCELLED" });
assert.equal(voided.status, "VOID");
assert.equal(voided.profitUnits, 0);

const unsettled = settleHhadCompanionShadow(evaluated[0], {});
assert.equal(unsettled.status, "UNSETTLED");
assert.equal(unsettled.reason, "final-score-unavailable");
assert.equal(unsettled.profitUnits, null);

const skipped = evaluateHhadCompanionShadow(blockerCases[1][1]);
assert.equal(settleHhadCompanionShadow(skipped, { scoreHome: 0, scoreAway: 1 }).status, "UNSETTLED");

const reorderedSettlement = settleHhadCompanionShadow(reordered201, { away: 1, home: 0 });
assert.equal(reorderedSettlement.settlementHash, won.settlementHash, "equivalent frozen exposure and score must settle identically");
assert.equal(reorderedSettlement.exposureSettlementPairHash, won.exposureSettlementPairHash, "exposure/settlement pair hash is canonical");

console.log(JSON.stringify({
  ok: true,
  version: HHAD_COMPANION_SHADOW_VERSION,
  strategyHash: STRATEGY_HASH,
  koreaFixtures: evaluated.map((exposure) => ({
    matchKey: exposure.matchKey,
    action: exposure.action,
    outcome: exposure.selection.outcome,
    handicapLine: exposure.selection.handicapLineText,
    odds: exposure.selection.odds,
  })),
  blockerCases: blockerCases.length,
  koreaSettlementStatuses: koreaSettlements.map((row) => row.status),
  settlements: [won.status, lost.status, voided.status, unsettled.status],
}, null, 2));
