"use strict";
// Run the actual release gate against controlled source mutations. Never edit
// application files or bless missing safety checks just to make a gate green.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const gate = path.join(__dirname, "verifyPredictionsPageFocus.cjs");
const gateSource = fs.readFileSync(gate, "utf8");
const baseRequire = createRequire(gate);
const evaluate = mutate => {
  let payload, changed = false;
  const customFs = Object.create(fs);
  customFs.readFileSync = (filename, ...args) => {
    const original = fs.readFileSync(filename, ...args);
    if (!mutate || !String(filename).replaceAll("\\", "/").endsWith(mutate.file)) return original;
    const next = mutate.apply(String(original).replace(/\r\n?/g, "\n")); changed ||= next !== original;
    return next;
  };
  const testProcess = { exitCode: 0 };
  const wrapped = vm.runInNewContext(`(function(require, __dirname, console, process) { ${gateSource}\n})`, {});
  wrapped(name => name === "node:fs" ? customFs : baseRequire(name), __dirname,
    { log: text => { payload = JSON.parse(text); } }, testProcess);
  if (mutate) assert.equal(changed, true, "mutation must actually exercise current source");
  return { payload, exitCode: testProcess.exitCode };
};
const mutations = [
  { name: "bound reference skipped before cutoff", file: "src/services/analysisReferenceSelection.ts", apply: text => text.replace('if (publicRecord) {', 'if (!beforeCutoff && publicRecord) {'), gate: "analysis gives every" },
  { name: "bound reference borrows mutable clock", file: "src/services/analysisReferenceSelection.ts", apply: text => text.replace('sourceUpdatedAt: publicRecord.decisionAt', 'sourceUpdatedAt: modelReferenceTimestamp(match)'), gate: "analysis gives every" },
  { name: "diagnostic samples borrowed as formal samples", file: "src/pages/PredictionsList.tsx", apply: text => text.replace('const rawScorecardFormalRows = scorecardSample?.formalRecommendationRows;', 'const rawScorecardFormalRows = scorecardSample?.formalRecommendationRows ?? scorecardSample?.predictionRows;'), gate: "model scorecard separates" },
  { name: "audit borrows another cohort when absent", file: "src/pages/PredictionsList.tsx", apply: text => text.replace('const rawHitRateAuditSettled = hitRateAuditObserved?.settled;', 'const rawHitRateAuditSettled = hitRateAuditObserved?.settled ?? scorecardFormalRows;'), gate: "publication and candidate samples" },
  { name: "missing audit count becomes zero", file: "src/pages/PredictionsList.tsx", apply: text => text.replace("const hitRateAuditSettledLabel = hitRateAuditSettled === null ? '--' : String(hitRateAuditSettled);", 'const hitRateAuditSettledLabel = String(hitRateAuditSettled ?? 0);'), gate: "publication and candidate samples" },
  { name: "research clutter opened by default", file: "src/pages/PredictionsList.tsx", apply: text => text.replace('<details className="research-audit-disclosure"', '<details open className="research-audit-disclosure"'), gate: "research ledgers are accessible" },
  { name: "missing primary selection", file: "src/pages/PredictionsList.tsx", apply: text => text.replaceAll("const marketSelection = getListMarketSelection(", "const marketSelection = disabledSelection("), gate: "odds table highlights" },
  { name: "companion promoted to recommendation", file: "src/pages/PredictionsList.tsx", apply: text => {
    const start = text.indexOf("const handicapMarketSelection: ListMarketSelection | null");
    return text.slice(0, start) + text.slice(start).replace("tone: 'analysis'", "tone: 'recommendation'");
  }, gate: "odds table highlights" },
  { name: "handicap binding removed", file: "src/pages/PredictionsList.tsx", apply: text => text.replaceAll("sameHandicapLine(", "uncheckedLine("), gate: "odds table highlights" },
  { name: "reference becomes market leader claim", file: "src/pages/PredictionsList.tsx", apply: text => text.replace("The 500.com market leader is a comparison only; the published reference may differ and is excluded from formal results", "This direction is the de-vigged 500.com HAD market leader"), gate: "odds table highlights" },
  { name: "user date control removed", file: "src/pages/PredictionsList.tsx", apply: text => text.replaceAll("onSelectDate={handleDateSelect}", "onSelectDate={undefined}"), gate: "date navigation opens" },
  { name: "complete reference denominator removed", file: "src/pages/HitAndWin.tsx", apply: text => text.replace("validReviewBucket(referenceReviewPerformance?.cumulative)", "localPageOnlyBucket"), gate: "date navigation opens" },
];
const baseline = evaluate(); assert.equal(baseline.payload.ok, true); assert.equal(baseline.exitCode, 0);
for (const mutation of mutations) {
  const result = evaluate(mutation);
  assert.equal(result.exitCode, 1, mutation.name);
  assert.ok(result.payload.checks.some(check => check.name.startsWith(mutation.gate) && check.ok === false), mutation.name);
}
console.log(JSON.stringify({ ok: true, checks: 1 + mutations.length, gateChecks: baseline.payload.summary,
  rejectedMutations: mutations.map(row => row.name), productionDataTouched: false }, null, 2));
