"use strict";
const assert = require("node:assert/strict");
const { stableHash } = require("./historicalAsOfFeatureBuilder.cjs");
const { score, freezeProtocol } = require("./fixedAbcResearch.cjs");
const { validateArtifact, validateScore, renderCalibrationReport } = require("./renderFixedAbcCalibration.cjs");
const commit = body => ({ ...body, manifestHash: stableHash(body) });
const observations = ["1", "X", "2", "1"].map(actual => ({ actual, p: { "1": 0.5, X: 0.3, "2": 0.2 } }));
function fixture() {
  const s = score(observations, row => row.p);
  const research = commit({ version: "fixed-abc-historical-research-v2", researchOnly: true, productionEligible: false,
    strictPromotionEligible: false, protocol: freezeProtocol(), conclusion: { nominationAllowed: false },
    fitted: { testLabelsUsedForFitting: false, residualWeight: 0, temperatures: { A: 1, B: 1, C: 1 } },
    coverage: { pairedTestRows: 4, commonDirectionRows: 4 }, partition: { test: { rows: 4 } },
    reports: Object.fromEntries(["A", "B", "C"].map(route => [route, { allPaired: structuredClone(s), rawUncalibrated: structuredClone(s), commonDecisions: structuredClone(s),
      fixedFilter: { rows: 4, coverage: 1, candidate: structuredClone(s), sameRowsMarket: structuredClone(s) },
      pairedUncertainty: route === "A" ? null : { policy: freezeProtocol().uncertainty, rows: 4, researchOnly: true, promotionEligible: false, status: "insufficient-calendar-support", familyAdjusted: null } }])) });
  return commit({ version: "fixed-abc-research-run-v2", source: { dataset: "synthetic-only" }, research,
    ablations: commit({ syntheticOnly: true }), combinedConclusion: { nominationAllowed: false, productionEligible: false } });
}
function rehash(a) {
  const { manifestHash: ignoredInner, ...inner } = a.research;
  a.research = commit(inner);
  const { manifestHash: ignoredOuter, ...outer } = a;
  return commit(outer);
}
const checks = [];
function check(name, fn) { fn(); checks.push(name); }
function rejected(name, mutate) { check(name, () => { const a = fixture(); mutate(a); assert.throws(() => validateArtifact(rehash(a))); }); }
check("actual renderer creates nine charts and fixed 90-bin tables", () => {
  const a = fixture(), before = JSON.stringify(a), html = renderCalibrationReport(a);
  assert.equal((html.match(/<svg /g) || []).length, 9);
  assert.equal((html.match(/查看 .* 全部 10 个分箱/g) || []).length, 9);
  assert.equal((html.match(/class="calibrated-mark"/g) || []).length, 9);
  assert.ok(html.includes("模型修正权重为 0"));
  assert.ok(html.includes("不提供分箱置信区间"));
  assert.ok(html.includes("不是独立盲测"));
  assert.equal(JSON.stringify(a), before);
  assert.equal(renderCalibrationReport(a), html);
  assert.ok(!/<script|<iframe|<img|https?:\/\//i.test(html));
});
check("outer and inner commitments both enforced", () => {
  const a = fixture(); a.research.reports.A.allPaired.rows++;
  assert.throws(() => validateArtifact(a));
  const { manifestHash, ...body } = a;
  assert.throws(() => validateArtifact(commit(body)));
});
check("untrusted dataset text cannot inject active markup", () => {
  const a = fixture(); a.source.dataset = '<script>alert("x")</script>&';
  const html = renderCalibrationReport(rehash(a));
  assert.ok(html.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;"));
  assert.ok(!html.includes("<script>"));
});
for (const value of [null, "4", -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) rejected(`invalid count ${String(value)}`, a => { a.research.reports.A.allPaired.calibration.X[3].rows = value; });
rejected("changed bin counts rejected despite new hashes", a => a.research.reports.A.allPaired.calibration.X[3].rows++);
rejected("missing bin cannot be hidden", a => a.research.reports.B.allPaired.calibration.X.pop());
rejected("reordered bins rejected", a => a.research.reports.B.allPaired.calibration.X.reverse());
rejected("empty bin never fabricated zero", a => { a.research.reports.B.allPaired.calibration.X[0].meanProbability = 0; });
rejected("probability outside assigned bin rejected", a => { a.research.reports.B.allPaired.calibration.X[3].meanProbability = 0.8; });
rejected("observed frequency out of range rejected", a => { a.research.reports.B.allPaired.calibration.X[3].observedFrequency = 1.1; });
rejected("fractional positive count rejected", a => { a.research.reports.B.allPaired.calibration.X[3].observedFrequency = 0.1234; });
rejected("class counts must sum to number of matches", a => { a.research.reports.B.allPaired.calibration.X[3].observedFrequency = 0.5; });
rejected("same rows cannot have different actual class distributions", a => {
  const s = a.research.reports.B.allPaired;
  s.calibration.X[3].observedFrequency = 0.5; s.calibration['1'][5].observedFrequency = 0.25;
});
rejected("raw and calibrated class populations must agree", a => {
  const s = a.research.reports.B.rawUncalibrated;
  s.calibration.X[3].observedFrequency = 0.5; s.calibration['1'][5].observedFrequency = 0.25;
});
rejected("common direction denominator not mixed with full test", a => { a.research.coverage.commonDirectionRows = 3; });
rejected("filtered rows cannot replace full calibration cohort", a => { a.research.reports.C.allPaired.rows = 3; });
rejected("filtered coverage must reconcile", a => { a.research.reports.C.fixedFilter.coverage = 0.5; });
rejected("promotion flag cannot be enabled", a => { a.research.productionEligible = true; });
rejected("final test labels cannot be used for fitting", a => { a.research.fitted.testLabelsUsedForFitting = true; });
rejected("uncertainty may not use another population", a => { a.research.reports.C.pairedUncertainty.rows = 3; });
rejected("unrecognized uncertainty cannot be called computed", a => { a.research.reports.C.pairedUncertainty.status = "good"; });
rejected("uncertainty method may not drift from chart disclosure", a => { a.research.reports.C.pairedUncertainty.policy.blockDays = 1; });
rejected("market baseline may not claim fitted calibration", a => { a.research.fitted.temperatures.A = 0.9; });
rejected("committed protocol cannot silently change candidate grid", a => { a.research.protocol.residualWeights = [0, 0.9]; });
check("empty score retains null probabilities and no marks", () => {
  const empty = score([], row => row.p);
  assert.deepEqual(validateScore(empty, 0), { '1': 0, X: 0, '2': 0 });
  assert.equal(empty.accuracy, null);
  empty.calibration.X[0].observedFrequency = 0;
  assert.throws(() => validateScore(empty, 0));
});
check("probability endpoints zero and one remain in first and last bins", () => {
  const edge = score([{ actual: "1" }], () => ({ '1': 1, X: 0, '2': 0 }));
  assert.equal(edge.calibration['1'][9].rows, 1);
  assert.equal(edge.calibration.X[0].rows, 1);
  validateScore(edge, 1);
});
console.log(JSON.stringify({ ok: true, checks: checks.length, cases: checks }, null, 2));
