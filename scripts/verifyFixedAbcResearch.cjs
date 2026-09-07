"use strict";
const assert = require("node:assert/strict");
const { stableHash } = require("./historicalAsOfFeatureBuilder.cjs");
const { freezeProtocol, partitionRows, runFixedAbcResearch, direction, score } = require("./fixedAbcResearch.cjs");
const protocol = freezeProtocol({ sourceDataset: "synthetic", minimumFitRows: 3, minimumModelTrainingRows: 1,
  dates: { start: "2020-01-01", tune: "2020-02-01", calibrate: "2020-03-01", test: "2020-04-01", end: "2020-05-01" } });
const rows = Array.from({ length: 120 }, (_, i) => ({ eventId: `match-${String(i).padStart(3, "0")}`, marketFamily: "HAD", sourceDataset: "synthetic",
  forecastAt: new Date(Date.UTC(2020, 0, i + 1)).toISOString(), availableAt: new Date(Date.UTC(2020, 0, i + 2)).toISOString(),
  featureKnownThrough: new Date(Date.UTC(2020, 0, i)).toISOString(), trainingRows: i + 1, quality: 0.8,
  market: { "1": 0.45, X: 0.3, "2": 0.25 }, model: { "1": 0.4, X: 0.3, "2": 0.3 }, actual: ["1", "X", "2"][i % 3] }));
const passed = [];
const check = (name, fn) => { fn(); passed.push(name); };
const artifact = runFixedAbcResearch(rows, protocol);
check("fixed three-route protocol is committed and cannot become production eligible", () => {
  assert.deepEqual(Object.keys(artifact.reports), ["A", "B", "C"]);
  assert.equal(artifact.conclusion.nominationAllowed, false);
  assert.throws(() => freezeProtocol({ productionEligible: true }));
  assert.throws(() => freezeProtocol({ residualWeights: [0, 1] }));
});
check("calendar partitions and late boundary labels reconcile exactly", () => {
  assert.equal(Object.values(artifact.partition).reduce((n, p) => n + p.rows, 0) + artifact.coverage.excluded.length, rows.length);
  assert.equal(artifact.coverage.reasons["result-unavailable-at-next-fitting-boundary"], 3);
});
check("reversing input order gives byte-identical research output", () => assert.deepEqual(runFixedAbcResearch([...rows].reverse(), protocol), artifact));
check("changing final test outcomes cannot change weights or temperatures", () => {
  const changed = rows.map(r => r.forecastAt >= "2020-04-01T00:00:00.000Z" ? { ...r, actual: r.actual === "1" ? "2" : "1" } : r);
  const rerun = runFixedAbcResearch(changed, protocol);
  assert.deepEqual(rerun.fitted, artifact.fitted);
  assert.notEqual(rerun.manifestHash, artifact.manifestHash);
});
check("late calibration labels never enter calibration fit", () => {
  const changed = rows.map(r => r.forecastAt === "2020-03-05T00:00:00.000Z" ? { ...r, availableAt: "2020-04-02T00:00:00.000Z" } : r);
  const split = partitionRows(changed, protocol);
  assert.equal(split.excluded.filter(r => r.reason === "result-unavailable-at-next-fitting-boundary").length, 4);
  assert.ok(!split.segments.calibration.some(r => r.forecastAt === "2020-03-05T00:00:00.000Z"));
});
check("duplicate event snapshots cannot leak into a different partition", () => assert.throws(() => partitionRows([...rows, { ...rows[0], forecastAt: "2020-04-15T00:00:00.000Z", availableAt: "2020-04-16T00:00:00.000Z" }], protocol), /duplicate/));
check("future feature evidence fails closed", () => assert.throws(() => partitionRows([{ ...rows[0], featureKnownThrough: rows[0].forecastAt }], protocol), /leaks/));
check("mixed HAD and HHAD observations are rejected", () => assert.throws(() => partitionRows([{ ...rows[0], marketFamily: "HHAD" }], protocol), /mixed market/));
check("missing probabilities are disclosed instead of made uniform", () => {
  const split = partitionRows([{ ...rows[0], model: { "1": null, X: 0.3, "2": 0.7 } }], protocol);
  assert.equal(split.excluded[0].reason, "model-probability-missing-or-invalid");
});
check("unknown input quality is not silently replaced with full quality", () => assert.equal(partitionRows([{ ...rows[0], quality: null }], protocol).excluded[0].reason, "input-quality-unrecorded"));
check("zero samples have null accuracy and loss without a default 50 percent", () => {
  const empty = score([], r => r.market);
  assert.equal(empty.accuracy, null); assert.equal(empty.brier, null); assert.equal(empty.logLoss, null);
});
check("equal-highest probabilities abstain instead of forcing home", () => {
  assert.equal(direction({ "1": 0.4, X: 0.4, "2": 0.2 }), null);
  const scored = score([rows[0]], () => ({ "1": 0.4, X: 0.4, "2": 0.2 }));
  assert.equal(scored.rows, 1); assert.equal(scored.decided, 0); assert.equal(scored.accuracy, null);
});
check("three routes share the same all-paired test denominator and per-filter market rows", () => {
  for (const r of Object.values(artifact.reports)) {
    assert.equal(r.allPaired.rows, artifact.coverage.pairedTestRows);
    assert.equal(r.commonDecisions.rows, artifact.coverage.commonDirectionRows);
    assert.equal(r.commonDecisions.decided, r.commonDecisions.rows);
    assert.equal(r.fixedFilter.candidate.rows, r.fixedFilter.sameRowsMarket.rows);
    assert.equal(r.allPaired.calibration.X.reduce((n, b) => n + b.rows, 0), r.allPaired.rows);
  }
});
check("invalid or reordered calendar bounds cannot be rehashed into a valid protocol", () => {
  assert.throws(() => freezeProtocol({ dates: { ...protocol.dates, tune: "2020-02-31" } }));
  const bad = { ...protocol, dates: { ...protocol.dates, test: "2020-02-01" } };
  const { protocolHash: _, ...body } = bad;
  bad.protocolHash = stableHash(body);
  assert.throws(() => partitionRows(rows, bad));
});
check("protocol digest tampering is rejected", () => assert.throws(() => partitionRows(rows, { ...protocol, protocolHash: "0".repeat(64) })));
check("a route-specific tie removes the event from every common-direction denominator", () => {
  const changed = rows.map(r => r.forecastAt === "2020-04-02T00:00:00.000Z" ? { ...r, market: { "1": 0.4, X: 0.4, "2": 0.2 } } : r);
  const report = runFixedAbcResearch(changed, protocol);
  assert.equal(report.coverage.commonDirectionRows, report.coverage.pairedTestRows - 1);
  assert.ok(Object.values(report.reports).every(r => r.commonDecisions.decided === report.coverage.commonDirectionRows));
});
check("zero selected residual is explicitly calibration-only, never model superiority", () => {
  const marketBetter = rows.map(r => ({ ...r, actual: "1", market: { "1": 0.8, X: 0.1, "2": 0.1 }, model: { "1": 0.1, X: 0.8, "2": 0.1 } }));
  const report = runFixedAbcResearch(marketBetter, protocol);
  assert.equal(report.fitted.residualWeight, 0);
  assert.equal(report.conclusion.candidateUsesModelResidual, false);
  assert.equal(report.conclusion.nominationAllowed, false);
});
check("empty eligible segments retain diagnostic exclusion counts without lowering the floor", () => {
  assert.throws(() => runFixedAbcResearch(rows.map(r => ({ ...r, sourceDataset: "wrong-alias" })), protocol), error => {
    assert.equal(error.audit.reasons["outside-fixed-source"], rows.length);
    assert.equal(error.audit.counts.training, 0);
    return true;
  });
  assert.throws(() => freezeProtocol({ filter: { minimumQuality: 0, minimumMaximumProbability: 0 } }), /new implementation version/);
});
check("canonical identities and the committed inventory ceiling are enforced by the library", () => {
  for (const sourceDataset of [null, "", " ", " synthetic"]) assert.throws(() => freezeProtocol({ sourceDataset }), /source identity/);
  for (const eventId of [12, "", " ", " match-0"]) assert.throws(() => partitionRows([{ ...rows[0], eventId }], protocol), /identity/);
  assert.throws(() => partitionRows(rows, freezeProtocol({ ...Object.fromEntries(Object.entries(protocol).filter(([key]) => key !== "protocolHash")), maximumEvents: 100 })), /inventory limit/);
});
console.log(JSON.stringify({ ok: true, checks: passed.length, passed }, null, 2));
