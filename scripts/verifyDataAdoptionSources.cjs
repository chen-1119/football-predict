"use strict";
// Targeted in-memory regression: actual executing receipts -> frozen publisher
// -> TS projection. No historical replay, network, sync job, build or UI render.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { predictionSet, buildPredictionFeatureSnapshot } = require("./syncData.cjs");
const { verifyModelInputUsage } = require("../src/services/modelInputUsage.cjs");
const { bindPublicReferenceDecision: bind, attestPublicReferenceDecision: attest,
  pendingPublicReferenceEvidence: pending } = require("../src/services/publicReferenceDecision.cjs");

const root = path.resolve(__dirname, "..");
const compiled = ts.transpileModule(fs.readFileSync(path.join(root, "src/services/dataAdoption.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const serviceModule = { exports: {} };
new Function("require", "module", "exports", compiled)(id => id === "football-collector-diagnostics"
  ? require("../src/services/apiFootballDiagnostics.cjs") : require(id), serviceModule, serviceModule.exports);
const { getDataAdoptionReport: report } = serviceModule.exports;
const clone = value => JSON.parse(JSON.stringify(value));
const checks = [];
const check = (name, action) => { action(); checks.push(name); };
const formRow = match => report(match).calculationRows.find(row => row.key === "form");
const formSummary = match => match.predictionMeta.publicReferenceDecision.dataGaps.calculationUsage.rows.find(row => row.key === "form");
const now = Date.now();
const fixture = (training, fiveHundred) => {
  const recent = {
    home: { sampleSize: 12, goalsForAvg: 1.8, goalsAgainstAvg: 1.1, lastMatchAt: new Date(now - 7 * 86400000).toISOString() },
    away: { sampleSize: 12, goalsForAvg: 1.2, goalsAgainstAvg: 1.5, lastMatchAt: new Date(now - 7 * 86400000).toISOString() },
  };
  return {
    sourceMatchId: "adoption-sources-synthetic", kickoffTime: new Date(now + 2 * 86400000).toISOString(), status: "SCHEDULED",
    homeTeam: "Synthetic Home", awayTeam: "Synthetic Away", leagueName: "Synthetic League",
    odds: { odds1: 2.1, oddsX: 3.4, odds2: 3.3 }, oddsSource: "sporttery:HAD", oddsUpdatedAt: new Date(now - 60000).toISOString(),
    ...(training ? { formSnapshot: { ...clone(recent), sampleSize: 24,
      historicalSource: { source: "synthetic-history", version: "test-only", signature: "fixture-not-source-verification" } } } : {}),
    ...(fiveHundred ? { externalSignals: { fiveHundred: { recentForm: clone(recent) } } } : {}),
  };
};
function publish(training, fiveHundred) {
  const match = fixture(training, fiveHundred);
  const { probabilityModel } = predictionSet(match);
  assert.ok(probabilityModel.inputUsage.every(verifyModelInputUsage));
  const at = new Date(Date.now() + 1).toISOString();
  const current = { ...match, id: "sporttery_adoption-sources-synthetic", eventVersion: match.kickoffTime, probabilityModel,
    predictions: [{ marketType: "BEST", oddsPoolCode: "HAD", tipCode: "X", odds: 3.4, recommendationAction: "reference" }],
    predictionMeta: { generatedAt: at, decisionId: "adoption-sources-fixture", modelVersion: probabilityModel.version, policyVersion: "test-only" } };
  current.predictionMeta.featureSnapshot = buildPredictionFeatureSnapshot(current, at);
  const result = bind(current, null, at);
  const decision = result.predictionMeta.publicReferenceDecision;
  assert.equal(decision?.integrityVerified, true);
  assert.ok(decision.evidenceBinding);
  assert.equal(attest(decision, result)?.contentHash, decision.contentHash);
  assert.deepEqual(pending(result).evidence.probabilityModel.inputUsage, probabilityModel.inputUsage);
  return result;
}

const fixtures = {};
for (const [name, training, fiveHundred, sources] of [
  ["training-only", true, false, ["training-history"]],
  ["500-only", false, true, ["500-recent-form"]],
  ["both", true, true, ["training-history", "500-recent-form"]],
  ["zero", false, false, []],
]) {
  check(`actual arithmetic and frozen publisher preserve ${name} source candidates`, () => {
    const published = fixtures[name] = publish(training, fiveHundred);
    const raw = published.probabilityModel.inputUsage.find(receipt => receipt.stage === "form-lambda-blend");
    const summary = formSummary(published);
    const projected = formRow(published);
    assert.deepEqual(raw.candidates.map(candidate => candidate.source), sources);
    assert.deepEqual(summary.sources, sources);
    assert.deepEqual(projected.sources, sources);
    assert.equal(projected.sourceDetailsRecorded, true);
    assert.equal(projected.used, sources.length > 0);
    assert.equal(projected.weight, summary.weight);
    assert.equal(projected.receiptHash, raw.contentHash);
    assert.equal(published.predictionMeta.publicReferenceDecision.dataGaps.calculationUsage.sourceVerified, false);
  });
}

check("500-only usage cannot fabricate training-history samples or final adoption", () => {
  const result = report(fixtures["500-only"]);
  for (const key of ["homeForm", "awayForm"]) {
    const row = result.rows.find(value => value.key === key);
    assert.equal(row.sampleSize, null);
    assert.notEqual(row.state, "adopted");
  }
  assert.equal(fixtures["500-only"].predictionMeta.publicReferenceDecision.prediction.recommendationAction, "reference");
});

check("mutating live form, diagnostics or decision gaps cannot replace frozen source evidence", () => {
  const original = fixtures["training-only"];
  const changed = clone(original);
  changed.externalSignals = fixture(false, true).externalSignals;
  delete changed.formSnapshot;
  changed.predictionMeta.decisionDataGaps = { calculationUsage: { rows: [{ key: "form", sources: ["500-recent-form"] }] } };
  changed.probabilityModel.inputUsage = [];
  const before = JSON.stringify(original.predictionMeta.publicReferenceDecision);
  assert.deepEqual(report(changed), report(original));
  assert.equal(JSON.stringify(changed.predictionMeta.publicReferenceDecision), before);
  assert.equal(attest(changed.predictionMeta.publicReferenceDecision, changed)?.contentHash, report(original).referenceHash);
});

check("replaying an unchanged published decision keeps its source list and reference hash", () => {
  const original = fixtures["training-only"];
  const current = clone(original);
  current.externalSignals = fixture(false, true).externalSignals;
  current.predictionMeta.featureSnapshot.modelInputs.usageSummary = clone(
    fixtures["500-only"].predictionMeta.featureSnapshot.modelInputs.usageSummary);
  const replay = bind(current, original, new Date(Date.now() + 10).toISOString());
  assert.deepEqual(formRow(replay), formRow(original));
  assert.equal(report(replay).referenceHash, report(original).referenceHash);
  assert.deepEqual(replay.predictionMeta.publicReferenceDecision.prediction, original.predictionMeta.publicReferenceDecision.prediction);
});

check("projection arrays cannot mutate the frozen receipt", () => {
  const original = fixtures.both;
  const row = formRow(original);
  row.sources.reverse();
  row.sources.push("not-recorded");
  assert.deepEqual(formSummary(original).sources, ["training-history", "500-recent-form"]);
  assert.deepEqual(formRow(original).sources, ["training-history", "500-recent-form"]);
});

// Schema-defense fixtures below deliberately alter the trusted-input projection
// shape. They test the UI parser, not cryptographic attestation of altered data.
for (const [name, value] of [
  ["missing", undefined], ["null", null], ["string", "training-history"],
  ["object", { source: "training-history" }], ["unknown", ["current-provider"]],
  ["mixed invalid", ["training-history", 500]], ["null member", [null]],
  ["duplicate", ["training-history", "training-history"]],
  ["too many", ["training-history", "500-recent-form", "training-history"]],
  ["whitespace", [" training-history"]], ["wrong case", ["Training-history"]],
  ["sparse", Array(1)], ["positive empty", []],
]) {
  check(`invalid or unrecorded ${name} source details fail closed without rewriting usage`, () => {
    const changed = clone(fixtures["training-only"]);
    const summary = formSummary(changed);
    if (value === undefined) delete summary.sources;
    else summary.sources = value;
    const projected = formRow(changed);
    assert.deepEqual(projected.sources, []);
    assert.equal(projected.sourceDetailsRecorded, false);
    assert.equal(projected.used, true);
    assert.equal(projected.weight, summary.weight);
    assert.equal(projected.receiptHash, summary.receiptHash);
    assert.deepEqual(report(changed).rows, report(fixtures["training-only"]).rows);
  });
}

check("zero-input recorded empty array is distinct from zero-use missing source details", () => {
  const changed = clone(fixtures.zero);
  delete formSummary(changed).sources;
  assert.equal(formRow(changed).sourceDetailsRecorded, false);
  assert.deepEqual(formRow(changed).sources, []);
  assert.equal(formRow(changed).used, false);
  assert.equal(formRow(changed).weight, 0);
  assert.equal(formRow(fixtures.zero).sourceDetailsRecorded, true);
});

check("recorded candidates never upgrade a zero-weight stage to used", () => {
  const changed = clone(fixtures.zero);
  formSummary(changed).sources = ["500-recent-form"];
  assert.equal(formRow(changed).sourceDetailsRecorded, true);
  assert.deepEqual(formRow(changed).sources, ["500-recent-form"]);
  assert.equal(formRow(changed).used, false);
  assert.equal(formRow(changed).weight, 0);
});

check("source details are specific to the joint form stage and preserve singular market source", () => {
  const changed = clone(fixtures.both);
  const summary = changed.predictionMeta.publicReferenceDecision.dataGaps.calculationUsage.rows;
  const market = summary.find(row => row.key === "officialOdds");
  market.sources = ["500-recent-form"];
  const result = report(changed).calculationRows.find(row => row.key === "officialOdds");
  assert.equal(result.source, "sporttery:HAD");
  assert.deepEqual(result.sources, []);
  assert.equal(result.sourceDetailsRecorded, false);
  formSummary(changed).key = "homeForm";
  const side = report(changed).calculationRows.find(row => row.key === "homeForm");
  assert.deepEqual(side.sources, []);
  assert.equal(side.sourceDetailsRecorded, false);
});

for (const [name, mutate] of [
  ["missing evidence binding", match => { match.predictionMeta.publicReferenceDecision.evidenceBinding = null; }],
  ["invalid integrity", match => { match.predictionMeta.publicReferenceDecision.integrityVerified = false; }],
  ["absent public record", match => { delete match.predictionMeta.publicReferenceDecision; }],
  ["incorrect scope", match => { match.predictionMeta.publicReferenceDecision.dataGaps.calculationUsage.scope = "final-adoption"; }],
  ["source-truth claim", match => { match.predictionMeta.publicReferenceDecision.dataGaps.calculationUsage.sourceVerified = true; }],
]) {
  check(`${name} cannot project source use or fall back to live receipts`, () => {
    const changed = clone(fixtures.both);
    changed.predictionMeta.decisionDataGaps = clone(changed.predictionMeta.publicReferenceDecision.dataGaps);
    mutate(changed);
    assert.deepEqual(report(changed).calculationRows, []);
  });
}

console.log(JSON.stringify({ ok: true, checks: checks.length, cases: checks,
  scope: "4 real in-memory calculation/publisher fixtures plus defensive TS projection mutations; no network, history replay or UI rendering",
  sourceTruthVerified: false, finalAdoptionAsserted: false, modelMathChanged: false }, null, 2));
