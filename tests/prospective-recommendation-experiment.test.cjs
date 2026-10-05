"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { buildDiagnostic, prematchGroupKeys, sha256 } = require("../scripts/prospectiveRecommendationExperiment.cjs");
const fixtureSpec = require("../scripts/fixtures/prospective-recommendation-experiment-v1.json");
const clone = object => JSON.parse(JSON.stringify(object));
function row(id, probabilities, outcome) {
  return { record: { matchId: String(id), market: "HAD", league: id === 1 ? "L1" : "L2", cutoffAt: "2026-09-10T11:00:00Z", kickoffAt: "2026-09-10T12:00:00Z",
    decision: { id: `d${id}`, at: "2026-09-10T10:00:00Z", capturedAt: "2026-09-10T10:00:00Z", modelVersion: "v-test", sourceCycleId: "cycle", probabilities },
    officialOdds: { sp: { home: 2, draw: 4, away: 4 }, providerObservedAt: "2026-09-10T09:00:00Z", receivedAt: "2026-09-10T09:30:00Z", sourceCycleId: "cycle", provenanceHash: "a".repeat(64) },
    result: { outcome, observedAt: "2026-09-10T15:00:00Z" } }, originalEligible: true, pairedEligible: true, primaryReason: "paired-accepted", reasons: [], clockBlockers: [], providerBlockers: [] };
}
function fixture() {
  return [row(1, { home: 0.6, draw: 0.2, away: 0.2 }, "home"), row(2, { home: 0.2, draw: 0.2, away: 0.6 }, "away")];
}
function run(rows = fixture(), mutate = () => {}) {
  const bytes = Buffer.from(rows.map(item => JSON.stringify(item)).join("\n") + "\n");
  const spec = clone(fixtureSpec);
  spec.source = { ...spec.source, evidenceSha256: sha256(bytes), expectedRows: rows.length, expectedPairedRows: rows.filter(item => item.pairedEligible === true).length };
  spec.bootstrap.iterations = 200;
  mutate(spec);
  return buildDiagnostic(bytes, spec);
}
test("same-group model/market comparison preserves denominators and selected-event identity", () => {
  const report = run();
  assert.equal(report.overall.models.publishedModel.hitRate, 1);
  assert.equal(report.overall.models.sameDecisionMarket.hitRate, 0.5);
  const disagreement = report.groups.agreement.find(group => group.value === "disagree");
  assert.equal(disagreement.rows, 1);
  assert.equal(disagreement.coverageOfPaired, 0.5);
  assert.equal(disagreement.models.publishedModel.rows, disagreement.models.sameDecisionMarket.rows);
  assert.equal(disagreement.sameModelSelectedEvent.hits, 1);
  assert.equal(disagreement.sameModelSelectedEvent.market.brier, (0.25 - 1) ** 2);
  assert.equal(disagreement.pairedDifference.intervalAvailable, false);
  assert.equal(report.groups.modelDirection.find(group => group.value === "draw").rows, 0);
  assert.equal(report.disagreementAppendix.length, 1);
  assert.equal(report.disagreementAppendix[0].matchId, "2");
  assert.deepEqual(report.disagreementAppendix[0].frozenModelProbabilities, fixture()[1].record.decision.probabilities);
});
test("each dimension partitions the common cohort with identical comparison membership", () => {
  const report = run();
  for (const groups of Object.values(report.groups)) {
    assert.equal(groups.reduce((sum, group) => sum + group.rows, 0), 2);
    assert.equal(groups.reduce((sum, group) => sum + group.coverageOfPaired, 0), 1);
    assert.deepEqual(groups.flatMap(group => group.eventIds).sort(), report.overall.eventIds);
  }
});
test("all outcome permutations leave every group membership unchanged", () => {
  const original = fixture();
  const baseline = run(original);
  for (const outcome of ["home", "draw", "away"]) {
    const changed = clone(original);
    changed.forEach(item => { item.record.result.outcome = outcome; });
    const report = run(changed);
    for (const name of Object.keys(report.groups)) assert.deepEqual(report.groups[name].map(group => group.commonEventSetHash), baseline.groups[name].map(group => group.commonEventSetHash));
  }
});
test("groups never read actual/result and exact argmax ties use stable home/draw/away order", () => {
  const projection = { predictions: { publishedModel: { home: 0.4, draw: 0.4, away: 0.2 }, sameDecisionMarket: { home: 0.5, draw: 0.25, away: 0.25 } }, favoriteSp: 2, league: "L" };
  Object.defineProperty(projection, "actual", { get() { throw new Error("label leakage"); } });
  assert.equal(prematchGroupKeys(projection, fixtureSpec).modelDirection, "home");
});
test("input and specification are unchanged", () => {
  const rows = fixture(); const before = JSON.stringify(rows); run(rows); assert.equal(JSON.stringify(rows), before);
});
test("tampered pinned bytes are rejected", () => {
  const bytes = Buffer.from("{}\n");
  assert.throws(() => buildDiagnostic(bytes, fixtureSpec), /hash mismatch/);
});
for (const [name, mutate, expression] of [
  ["duplicate event", rows => rows.push(clone(rows[0])), /duplicate/],
  ["contradictory eligibility", rows => { rows[0].clockBlockers = ["invalid"]; }, /receipt inconsistent/],
  ["future odds", rows => { rows[0].record.officialOdds.receivedAt = "2026-09-10T10:00:01Z"; }, /ordering/],
  ["submillisecond future odds", rows => { rows[0].record.officialOdds.receivedAt = "2026-09-10T10:00:00.000000001Z"; }, /ordering/],
  ["invalid calendar", rows => { rows[0].record.cutoffAt = "2026-02-30T11:00:00Z"; }, /invalid paired source clock/],
  ["cross cycle odds", rows => { rows[0].record.officialOdds.sourceCycleId = "other"; }, /same-decision/],
  ["outcome before kickoff", rows => { rows[0].record.result.observedAt = "2026-09-10T09:00:00Z"; }, /before kickoff/],
]) test(`reject ${name}`, () => { const rows = fixture(); mutate(rows); assert.throws(() => run(rows), expression); });
test("exclusions remain in source denominator and are never silently treated as losses", () => {
  const rows = fixture(); rows[1].pairedEligible = false; rows[1].primaryReason = "same-decision-sp-missing";
  const report = run(rows); assert.equal(report.overall.coverageOfSource, 0.5); assert.equal(report.overall.models.publishedModel.hitRate, 1); assert.equal(report.coverage.exclusions["same-decision-sp-missing"], 1);
});
test("unregistered historical diagnostic cannot assert future activation or promotion", () => {
  assert.throws(() => run(fixture(), spec => { spec.futureExecution.status = "active"; }), /cannot register/);
  assert.throws(() => run(fixture(), spec => { spec.source.alreadyInspected = false; }), /diagnostic-only/);
  const report = run(); assert.equal(report.productionEligible, false); assert.equal(report.improvementProven, false); assert.equal(report.futureExecution.started, false);
});
test("invalid or incomplete probability bins fail closed", () => {
  assert.throws(() => run(fixture(), spec => { spec.modelProbabilityEdges = [0, 0.6, 0.5, 1]; }), /ascending/);
  assert.throws(() => run(fixture(), spec => { spec.modelProbabilityEdges = [0.4, 1]; }), /cover/);
});
test("verified online 432/154 evidence reproduces established baseline and partitions", () => {
  const bytes = fs.readFileSync(path.join(__dirname, "../outputs/history-regression-20261002/report/per-match-evidence.jsonl"));
  const report = buildDiagnostic(bytes, fixtureSpec);
  assert.equal(report.coverage.sourceRows, 432); assert.equal(report.coverage.pairedRows, 154);
  assert.equal(report.overall.models.publishedModel.hits, 78); assert.equal(report.overall.models.sameDecisionMarket.hits, 83);
  assert.equal(report.disagreementAppendix.length, 26);
  assert.ok(report.disagreementAppendix.every(row => row.modelDirection !== row.marketDirection && /^[a-f0-9]{64}$/.test(row.sourceRecordHash)));
  assert.deepEqual(report.disagreementAppendix.map(row => row.matchId), [...report.disagreementAppendix].sort((a, b) => Date.parse(a.kickoffAt) - Date.parse(b.kickoffAt) || a.matchId.localeCompare(b.matchId)).map(row => row.matchId));
  assert.ok(Math.abs(report.overall.models.publishedModel.brier - 0.6247951452865698) < 1e-12);
  for (const groups of Object.values(report.groups)) assert.equal(groups.reduce((sum, group) => sum + group.rows, 0), 154);
});
