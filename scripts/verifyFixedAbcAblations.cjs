"use strict";
const assert = require("node:assert/strict");
const { buildDynamicGoalStrengthArtifact, buildDynamicGoalStrengthAblationArtifact, verifyDynamicGoalStrengthArtifact } = require("./dynamicGoalStrengthModel.cjs");
const { freezeProtocol } = require("./fixedAbcResearch.cjs");
const { KNOCKOUTS, runFixedAbcAblations } = require("./fixedAbcAblationResearch.cjs");
const events = Array.from({ length: 180 }, (_, i) => {
  const date = new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10);
  return { sourceEventId: `fixture-${i}`, sourceDataset: "synthetic", competition: "L1", date,
    homeTeam: { raw: `Team${i % 4}`, normalized: `team${i % 4}` }, awayTeam: { raw: `Team${(i + 1) % 4}`, normalized: `team${(i + 1) % 4}` },
    historicalOutcome: { homeGoals: (i % 3) + 1, awayGoals: i % 2 }, availableAt: new Date(Date.UTC(2024, 0, i + 3)).toISOString() };
});
const base = buildDynamicGoalStrengthArtifact(events);
const labels = new Map(base.featureArtifact.labels.map(l => [l.sourceEventId, l]));
const rows = base.featureArtifact.snapshots.map(s => ({ eventId: s.sourceEventId, sourceDataset: "synthetic", marketFamily: "HAD",
  forecastAt: s.forecastBoundary, availableAt: labels.get(s.sourceEventId).availableAt, featureKnownThrough: s.stateWatermark.maxConsumedAvailableAt,
  trainingRows: s.stateWatermark.consumedRows, quality: 0.8, market: { "1": 0.45, X: 0.3, "2": 0.25 }, model: s.probabilities.final, actual: labels.get(s.sourceEventId).outcome }));
const protocol = freezeProtocol({ sourceDataset: "synthetic", minimumFitRows: 3, minimumModelTrainingRows: 1,
  dates: { start: "2024-01-01", tune: "2024-02-01", calibrate: "2024-03-01", test: "2024-04-01", end: "2024-08-01" } });
const passed = []; const check = (name, fn) => { fn(); passed.push(name); };
const report = runFixedAbcAblations(events, rows, protocol);
check("three exact knockouts are complete, private and non-promotable", () => {
  assert.deepEqual(Object.keys(report.reports), ["full-model", ...KNOCKOUTS]);
  assert.equal(report.productionEligible, false); assert.equal(report.nominationAllowed, false);
  assert.throws(() => buildDynamicGoalStrengthAblationArtifact(events, "best-of-grid"), /unknown/);
});
check("normal model config cannot activate a research knockout", () => {
  assert.deepEqual(buildDynamicGoalStrengthArtifact(events, { config: { researchAblation: "without-venue" } }), base);
});
check("every knockout has a distinct verified identity and changes actual probabilities", () => {
  for (const name of KNOCKOUTS) {
    const a = buildDynamicGoalStrengthAblationArtifact(events, name);
    assert.ok(verifyDynamicGoalStrengthArtifact(a)); assert.equal(a.model.config.researchAblation, name);
    assert.notEqual(a.model.configHash, base.model.configHash);
    assert.ok(a.featureArtifact.snapshots.some((s, i) => JSON.stringify(s.probabilities.final) !== JSON.stringify(base.featureArtifact.snapshots[i].probabilities.final)));
  }
});
check("without venue actually zeroes every Elo home advantage", () => {
  const a = buildDynamicGoalStrengthAblationArtifact(events, "without-venue");
  assert.ok(a.featureArtifact.snapshots.every(s => s.features.elo.homeAdvantage === 0));
});
check("without opponent strength removes relative Elo from expectations", () => {
  const a = buildDynamicGoalStrengthAblationArtifact(events, "without-opponent-strength");
  assert.equal(new Set(a.featureArtifact.snapshots.map(s => s.features.elo.expectedHome)).size, 1);
});
check("future labels cannot change earlier predictions in any knockout", () => {
  const changed = structuredClone(events); changed.at(-1).historicalOutcome.homeGoals = 9;
  for (const name of KNOCKOUTS) assert.deepEqual(buildDynamicGoalStrengthAblationArtifact(changed, name).featureArtifact.snapshots,
    buildDynamicGoalStrengthAblationArtifact(events, name).featureArtifact.snapshots);
});
check("all variants and market use common probability and direction denominators", () => {
  for (const r of Object.values(report.reports)) {
    assert.equal(r.allPaired.rows, report.rows); assert.equal(r.commonDecisions.rows, report.commonDirectionRows);
    assert.equal(r.commonDecisions.decided, report.commonDirectionRows);
  }
  assert.equal(report.sameRowsMarket.commonDecisions.decided, report.commonDirectionRows);
  assert.deepEqual(report.reports["full-model"].lossIncreaseVersusFull, { brier: 0, logLoss: 0 });
});
check("identity and clock mismatch cannot silently change the ablation sample", () => {
  const bad = rows.map(r => r.forecastAt.startsWith("2024-04-10") ? { ...r, eventId: "unrelated" } : r);
  assert.throws(() => runFixedAbcAblations(events, bad, protocol), /mismatch/);
});
check("reversed events and snapshots replay identically", () => assert.deepEqual(runFixedAbcAblations([...events].reverse(), [...rows].reverse(), protocol), report));
console.log(JSON.stringify({ ok: true, checks: passed.length, passed }, null, 2));
