"use strict";
const assert = require("node:assert/strict");
const { POLICY, assessFormRecency, buildFormRecencyShadowInput } = require("./formRecencyShadow.cjs");
const { predictionSet } = require("./syncData.cjs");
const { verifyModelInputUsage } = require("../src/services/modelInputUsage.cjs");
const { evaluateRow } = require("./runFormRecencyShadow.cjs");
const { createHash } = require("node:crypto");
const at = "2026-09-08T00:00:00.000Z";
const daysAgo = days => new Date(Date.parse(at) - days * 86400000).toISOString();
const form = (homeDays = 10, awayDays = 10) => ({ sampleSize: 24,
  home: { sampleSize: 12, goalsForAvg: 1.33, goalsAgainstAvg: 1.25, lastMatchAt: daysAgo(homeDays) },
  away: { sampleSize: 12, goalsForAvg: 2.75, goalsAgainstAvg: 1.08, lastMatchAt: daysAgo(awayDays) },
  historicalSource: { source: "synthetic-history", version: "test" } });
let checks = 0;
const check = (name, test) => { test(); checks++; };
check("recent and exactly 60-day history remain recent", () => assert.equal(assessFormRecency(form(60, 10), at).status, "recent"));
check("older but within maximum stays explicitly aged history", () => assert.equal(assessFormRecency(form(60.01, 240), at).status, "aged-history"));
check("maximum is applied independently to both teams", () => {
  for (const [home, away] of [[240.01, 10], [10, 240.01], [485, 25]]) assert.equal(assessFormRecency(form(home, away), at).usable, false);
});
check("missing source is not a zero-goal observation", () => assert.equal(assessFormRecency(null, at).status, "missing"));
for (const value of [undefined, null, true, "", "2026-02-30T00:00:00Z", "2026-09-01 00:00:00"]) check("invalid source clock rejected: " + value, () => {
  const input = form(); input.home.lastMatchAt = value; assert.equal(assessFormRecency(input, at).usable, false);
});
check("result before future kickoff but after evaluation cannot become known form", () => assert.equal(assessFormRecency(form(-1, 10), at).usable, false));
check("invalid evaluation clock cannot fall back to now or kickoff", () => assert.throws(() => assessFormRecency(form(), "2026-09-31T00:00:00Z")));
check("offset-equivalent clocks have identical classification", () => {
  const input = form(); input.home.lastMatchAt = new Date(Date.parse(input.home.lastMatchAt)).toISOString();
  assert.deepEqual(assessFormRecency(input, at), assessFormRecency(input, "2026-09-08T08:00:00+08:00"));
});
const match = { id: "sporttery_shadow-recency", sourceMatchId: "shadow-recency", kickoffTime: "2026-09-10T00:45:00+08:00", status: "SCHEDULED",
  homeTeamName: "Synthetic Home", awayTeamName: "Synthetic Away", leagueName: "Synthetic league",
  odds: { odds1: 1.8, oddsX: 3.4, odds2: 4.2 }, oddsSource: "sporttery:HAD", oddsUpdatedAt: at, formSnapshot: form(485, 25),
  archivedPreMatchPrediction: { fixtureOnly: true, tipCode: "X" },
  predictionMeta: { publicReferenceDecision: { fixtureOnly: true, contentHash: "original-test-reference" } },
  externalSignals: { fiveHundred: { recentForm: form(10, 10), otherSignal: "retained" } } };
check("source gating is independent and does not remove unrelated data", () => {
  const before = JSON.stringify(match), shadow = buildFormRecencyShadowInput(match, at);
  assert.deepEqual(shadow.audit.removedSources, ["training-history"]);
  assert.equal(shadow.input.formSnapshot, undefined); assert.deepEqual(shadow.input.externalSignals, match.externalSignals);
  assert.deepEqual(shadow.input.archivedPreMatchPrediction, match.archivedPreMatchPrediction);
  assert.deepEqual(shadow.input.predictionMeta, match.predictionMeta); assert.equal(JSON.stringify(match), before);
});
check("500 source with absent clocks is excluded without borrowing training clocks", () => {
  const input = structuredClone(match); input.formSnapshot = form(); delete input.externalSignals.fiveHundred.recentForm.home.lastMatchAt;
  const shadow = buildFormRecencyShadowInput(input, at);
  assert.deepEqual(shadow.audit.removedSources, ["500-recent-form"]);
  assert.equal(shadow.input.externalSignals.fiveHundred.otherSignal, "retained"); assert.deepEqual(shadow.input.formSnapshot, input.formSnapshot);
});
check("whole actual prediction pipeline exposes old stale use and shadow removes it", () => {
  const input = structuredClone(match); delete input.externalSignals; delete input.predictionMeta; delete input.archivedPreMatchPrediction;
  const original = predictionSet(structuredClone(input));
  const shadow = predictionSet(buildFormRecencyShadowInput(input, at).input);
  const receipt = model => model.inputUsage.find(row => row.stage === "form-lambda-blend");
  assert.equal(receipt(original.probabilityModel).weight, 0.42, "actual old scorer gives full paired-sample confidence despite 485-day history");
  assert.equal(receipt(shadow.probabilityModel).weight, 0);
  assert.ok(original.probabilityModel.inputUsage.every(verifyModelInputUsage));
  assert.ok(shadow.probabilityModel.inputUsage.every(verifyModelInputUsage));
  assert.notDeepEqual(shadow.probabilityModel.oneXTwo.final, original.probabilityModel.oneXTwo.final);
});
check("no production or nomination authority and no arbitrary policy override", () => {
  const shadow = buildFormRecencyShadowInput(match, at, { maximumAgeDays: Infinity, productionEligible: true });
  assert.equal(POLICY.maximumAgeDays, 240); assert.equal(shadow.audit.productionEligible, false);
  assert.equal(shadow.audit.nominationAllowed, false); assert.equal(shadow.audit.sourceVerified, false);
});
function publishedFixture() {
  const input = structuredClone(match); delete input.externalSignals;
  const scored = predictionSet(input);
  input.probabilityModel = scored.probabilityModel;
  input.probabilityModel.generatedAt = at;
  for (const receipt of input.probabilityModel.inputUsage) {
    receipt.recordedAt = at;
    const { contentHash: unused, ...body } = receipt;
    void unused;
    receipt.contentHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  }
  delete input.formSnapshot;
  return input;
}
check("compact row replays only receipt-bound stage and leaves public record intact", () => {
  const input = publishedFixture(), before = JSON.stringify(input), result = evaluateRow(input).result;
  assert.ok(result); assert.equal(result.originalArithmeticReplayMatched, true);
  assert.equal(result.baseline.weight, 0.42); assert.equal(result.alternative.weight, 0);
  assert.equal(result.originalPublicRecordHash, "original-test-reference");
  assert.equal(JSON.stringify(input), before);
});
check("missing original receipts are excluded, never counted as no form effect", () => {
  const input = publishedFixture(); delete input.probabilityModel.inputUsage;
  assert.equal(evaluateRow(input).excluded.reason, "original-form-arithmetic-receipt-missing");
});
check("retained form that cannot exactly reproduce original arithmetic is excluded", () => {
  const input = publishedFixture(); input.probabilityModel.form.home.goalsForAvg += 0.5;
  assert.equal(evaluateRow(input).excluded.reason, "original-form-arithmetic-replay-mismatch");
});
check("changed receipt hash or model weight binding cannot be accepted", () => {
  for (const change of [input => input.probabilityModel.inputUsage[0].contentHash = "bad", input => input.probabilityModel.lambdaBlend.formWeight = 0.1]) {
    const input = publishedFixture(); change(input);
    assert.equal(evaluateRow(input).excluded.reason, "original-form-receipt-or-model-binding-invalid");
  }
});
check("stage replay rejects invalid, ambiguous or post-kickoff model clocks", () => {
  for (const clock of ["2026-02-30T00:00:00Z", "2026-09-08 00:00:00", match.kickoffTime]) {
    const input = publishedFixture(); input.probabilityModel.generatedAt = clock;
    assert.equal(evaluateRow(input).excluded.reason, "original-form-receipt-or-model-binding-invalid");
  }
});
check("self-hashed but invalid receipt calendar cannot pass stage replay", () => {
  const input = publishedFixture(), receipt = input.probabilityModel.inputUsage[0];
  receipt.recordedAt = "2026-02-30T00:00:00Z";
  const { contentHash: unused, ...body } = receipt; void unused;
  receipt.contentHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  assert.equal(evaluateRow(input).excluded.reason, "original-form-receipt-or-model-binding-invalid");
});
check("malformed rows and receipt collections never become successful no-op samples", () => {
  assert.equal(evaluateRow(null).excluded.reason, "invalid-match-row");
  const input = publishedFixture(); input.probabilityModel.inputUsage = {};
  assert.equal(evaluateRow(input).excluded.reason, "original-form-arithmetic-receipt-missing");
});
console.log(JSON.stringify({ ok: true, verifier: "form-recency-input-shadow-v1", checks, productionDataTouched: false, modelWeightsChanged: false,
  scope: "separate shadow input-removal rule and actual scorer replay; not a production model change" }, null, 2));
