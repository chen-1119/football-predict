"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const Module = require("node:module");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { verifyModelInputUsage: verify, summarizeModelInputUsage: summarize } = require("../src/services/modelInputUsage.cjs");
const { predictionSet, buildPredictionFeatureSnapshot } = require("./syncData.cjs");
const { bindPublicReferenceDecision: bind, pendingPublicReferenceEvidence: pending } = require("../src/services/publicReferenceDecision.cjs");
const root = path.resolve(__dirname, "..");
const clone = v => JSON.parse(JSON.stringify(v));
let checks = 0;
const check = (name, fn) => { fn(); checks++; };
const fixture = () => ({ sourceMatchId: "usage-fixture", kickoffTime: "2026-09-08T12:00:00.000Z", status: "SCHEDULED",
  homeTeam: "Synthetic Home", awayTeam: "Synthetic Away", leagueName: "Synthetic League",
  odds: { odds1: 2.1, oddsX: 3.4, odds2: 3.3 }, oddsSource: "sporttery:HAD", oddsUpdatedAt: "2026-09-07T00:00:00.000Z",
  eloSnapshot: { probabilities: { home: 0.45, draw: 0.3, away: 0.25 }, homeRating: 1550, awayRating: 1500,
    homeMatches: 20, awayMatches: 20, diff: 50, historicalSource: { source: "synthetic-history", version: "v1", signature: "test-only" } },
  formSnapshot: { sampleSize: 24, home: { sampleSize: 12, goalsForAvg: 1.8, goalsAgainstAvg: 1.1, lastMatchAt: "2026-09-01T12:00:00.000Z" },
    away: { sampleSize: 12, goalsForAvg: 1.2, goalsAgainstAvg: 1.5, lastMatchAt: "2026-09-01T12:00:00.000Z" },
    historicalSource: { source: "synthetic-history", version: "v1", signature: "test-only" } },
});
const match = fixture();
const generated = predictionSet(match);
const model = generated.probabilityModel;
check("actual prediction pipeline emits both executed stages", () => {
  assert.equal(model.inputUsage.length, 2);
  assert.ok(model.inputUsage.every(verify));
});
check("summary records actual nonzero market, Elo and form weights without claiming final adoption", () => {
  const summary = summarize(model, match);
  assert.equal(summary.scope, "base-calculation-only");
  assert.equal(summary.sourceVerified, false);
  for (const key of ["officialOdds", "elo", "form"]) assert.ok(summary.rows.find(r => r.key === key).used);
});
for (const entry of model.inputUsage) check("arithmetic replay rejects changed output even with recomputed hash: " + entry.stage, () => {
  const bad = clone(entry); bad.output.home += 0.01;
  const { contentHash, ...body } = bad; void contentHash;
  bad.contentHash = crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
  assert.equal(verify(bad), false);
});
check("invalid identity, future receipt or stale output binding cannot generate summary", () => {
  for (const mutation of [m => { m.inputUsage[0].sourceMatchId = "other"; }, m => { m.inputUsage[0].recordedAt = "2099-01-01T00:00:00Z"; },
    m => { m.calibrationAdjustment.oneXTwo.before.home += 1; }, m => { m.lambdaBlend.formWeight += 0.1; }]) {
    const m = clone(model); mutation(m);
    for (const receipt of m.inputUsage) {
      const { contentHash, ...body } = receipt; void contentHash;
      receipt.contentHash = crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
    }
    assert.equal(summarize(m, match), null);
  }
});
check("absent receipts are not retroactively inferred from formula trace", () => {
  const m = clone(model); delete m.inputUsage; assert.equal(summarize(m, match), null);
});
check("empty and one-sided form explicitly record zero use", () => {
  for (const form of [null, { ...clone(match.formSnapshot), away: { sampleSize: 0 } }]) {
    const m = { ...match, formSnapshot: form }; const result = predictionSet(m);
    const row = summarize(result.probabilityModel, m).rows.find(r => r.key === "form");
    assert.equal(row.used, false); assert.equal(row.weight, 0);
  }
});
check("missing metrics are marked as fallback, not four observed measurements", () => {
  const m = fixture(); m.formSnapshot.home.goalsForAvg = null;
  const result = predictionSet(m);
  assert.equal(summarize(result.probabilityModel, m).rows.find(r => r.key === "form").fallbackMetrics, 1);
});
check("actual numeric zero goals is not marked as missing", () => {
  const m = fixture(); m.formSnapshot.home.goalsForAvg = 0;
  assert.equal(summarize(predictionSet(m).probabilityModel, m).rows.find(r => r.key === "form").fallbackMetrics, 0);
});
check("HHAD-only anchor is explicitly labelled HHAD, not an HAD observation", () => {
  const m = fixture(); delete m.odds; m.handicapLine = -1; m.handicapOdds = { odds1: 3.7, oddsX: 3.2, odds2: 1.9 }; m.handicapOddsSource = "sporttery:HHAD";
  const summary = summarize(predictionSet(m).probabilityModel, m);
  assert.equal(summary.rows.find(r => r.key === "officialOdds").poolCode, "HHAD");
});
check("unknown market source is not called official or external source evidence", () => {
  const m = fixture(); delete m.oddsSource;
  const summary = summarize(predictionSet(m).probabilityModel, m);
  assert.ok(summary.rows.find(r => r.key === "unknownMarketAnchor"));
});
check("new public evidence preserves the exact original execution receipts", () => {
  const at = new Date(Date.now() + 10).toISOString();
  const current = { ...match, id: "sporttery_usage-fixture", eventVersion: match.kickoffTime, probabilityModel: model,
    predictions: [{ marketType: "BEST", oddsPoolCode: "HAD", tipCode: "X", odds: 3.4, recommendationAction: "reference" }],
    predictionMeta: { generatedAt: at, decisionId: "usage-test", modelVersion: model.version, policyVersion: "test" } };
  current.predictionMeta.featureSnapshot = buildPredictionFeatureSnapshot(current, at);
  assert.ok(current.predictionMeta.featureSnapshot.modelInputs.usageSummary);
  const published = bind(current, null, at);
  assert.deepEqual(pending(published).evidence.probabilityModel.inputUsage, model.inputUsage);
  assert.deepEqual(published.predictionMeta.publicReferenceDecision.dataGaps.calculationUsage, current.predictionMeta.featureSnapshot.modelInputs.usageSummary);
});
check("actual detail model normalizer hides raw receipts while preserving public probability data", () => {
  const source = fs.readFileSync(path.join(root, "server", "index.cjs"), "utf8");
  const start = source.indexOf("const normalizeProbabilityModelForDetail =");
  const end = source.indexOf("const compactVerifiedDualMarketDecision =", start);
  assert.ok(start >= 0 && end > start);
  const normalize = new Function("normalizeProbabilityLaneForDetail", "finiteNumberOrNull", source.slice(start, end) + "\nreturn normalizeProbabilityModelForDetail;")(v => v, v => typeof v === "number" && Number.isFinite(v) ? v : null);
  const result = normalize(model);
  assert.equal(Object.hasOwn(result, "inputUsage"), false);
  assert.deepEqual(result.oneXTwo, model.oneXTwo);
  assert.equal(model.inputUsage.length, 2);
});

// Compare mathematical outputs against the immutable pre-Q1 baseline source.
// This is a development-worktree regression, not a production runtime test.
const baselineSource = execFileSync("git", ["show", "85759308a826e73b50681335ecf928802cc6f1dd:scripts/syncData.cjs"], { cwd: root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
const baseline = new Module(path.join(root, "scripts", "usage-baseline.cjs"), module);
baseline.filename = path.join(root, "scripts", "usage-baseline.cjs");
baseline.paths = Module._nodeModulePaths(path.join(root, "scripts"));
baseline._compile(baselineSource, baseline.filename);
const math = output => ({ oneXTwo: output.probabilityModel.oneXTwo, weights: output.probabilityModel.ensembleWeights,
  lambdaBlend: output.probabilityModel.lambdaBlend, goalLines: output.probabilityModel.goalLines,
  handicap: output.probabilityModel.handicap, predictions: output.predictions.map(r => ({ market: r.marketType, pool: r.oddsPoolCode, tip: r.tipCode, odds: r.odds, action: r.recommendationAction })) });
for (const [name, mutate] of [
  ["full", () => {}], ["no form", m => { delete m.formSnapshot; }], ["no elo", m => { delete m.eloSnapshot; }],
  ["zero goals", m => { m.formSnapshot.home.goalsForAvg = 0; }], ["null metric", m => { m.formSnapshot.home.goalsForAvg = null; }],
  ["one sided", m => { m.formSnapshot.away.sampleSize = 0; }], ["external odds", m => { m.oddsSource = "500.com:HAD"; }],
]) check("instrumentation preserves exact baseline mathematics and selections: " + name, () => {
  const m = fixture(); mutate(m);
  assert.deepEqual(math(predictionSet(clone(m))), math(baseline.exports.predictionSet(clone(m))));
});
console.log(JSON.stringify({ ok: true, checks, scope: "actual arithmetic, source feature capture and immutable baseline comparison", productionDataTouched: false, modelWeightsChanged: false }, null, 2));
