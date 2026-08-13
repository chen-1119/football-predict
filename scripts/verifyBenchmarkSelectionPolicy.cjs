const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  GOODWIN_BENCHMARK_SHADOW_POLICY,
  evaluateBenchmarkSelection,
} = require("../src/services/benchmarkSelectionPolicy.cjs");

const rootDir = path.resolve(__dirname, "..");
const bestTipsSource = fs.readFileSync(path.join(rootDir, "src", "pages", "BestTips.tsx"), "utf8");
const predictionsSource = fs.readFileSync(path.join(rootDir, "src", "pages", "PredictionsList.tsx"), "utf8");
const serverSource = fs.readFileSync(path.join(rootDir, "server", "index.cjs"), "utf8");
const apiContractSource = fs.readFileSync(path.join(rootDir, "scripts", "verifyApiContracts.cjs"), "utf8");

const qualified = evaluateBenchmarkSelection({
  marketType: "BEST",
  oddsPoolCode: "HAD",
  tipCode: "1",
  trustScore: 60,
  odds: 1.85,
});
assert.equal(qualified.qualified, true);

for (const prediction of [
  { marketType: "BEST", oddsPoolCode: "HHAD", tipCode: "1", trustScore: 80, odds: 1.5 },
  { marketType: "BEST", oddsPoolCode: "HAD", tipCode: "1", trustScore: 59, odds: 1.5 },
  { marketType: "BEST", oddsPoolCode: "HAD", tipCode: "1", trustScore: 70, odds: 1.19 },
  { marketType: "BEST", oddsPoolCode: "HAD", tipCode: "1", trustScore: 70, odds: 1.86 },
  { marketType: "BEST", oddsPoolCode: "HAD", tipCode: "WATCH", trustScore: 70, odds: 1.5 },
]) {
  assert.equal(evaluateBenchmarkSelection(prediction).qualified, false);
}

assert.equal(GOODWIN_BENCHMARK_SHADOW_POLICY.role, "shadow-only");
assert.equal(GOODWIN_BENCHMARK_SHADOW_POLICY.version, "goodwin-benchmark-prospective-shadow-v2");
assert.ok(Number.isFinite(Date.parse(GOODWIN_BENCHMARK_SHADOW_POLICY.activatedAt)));
assert.ok(GOODWIN_BENCHMARK_SHADOW_POLICY.minimumSettledRowsForPromotionReview >= 200);
assert.ok(GOODWIN_BENCHMARK_SHADOW_POLICY.minimumChronologicalFolds >= 6);
assert.equal(GOODWIN_BENCHMARK_SHADOW_POLICY.minimumOdds, 1.2);
assert.equal(GOODWIN_BENCHMARK_SHADOW_POLICY.hitRateDisclosureOnly, true);
assert.ok(GOODWIN_BENCHMARK_SHADOW_POLICY.minimumCalendarDays >= 42);
assert.ok(GOODWIN_BENCHMARK_SHADOW_POLICY.minimumClosingLineCoverage >= 0.95);
assert.deepEqual(GOODWIN_BENCHMARK_SHADOW_POLICY.reviewCheckpoints, [200, 300, 450, 700, 1050]);
assert.match(bestTipsSource, /benchmarkQualified \? 1000 : 0/);
assert.match(bestTipsSource, /Benchmark candidate · Shadow/);
assert.match(predictionsSource, /data-testid="benchmark-shadow-track"/);
assert.match(predictionsSource, /prospective settled; excluded from formal record/);
assert.match(predictionsSource, /data-ledger-chain-valid/);
assert.match(serverSource, /formalOnlineEffect: false/);
assert.match(serverSource, /GOODWIN_BENCHMARK: benchmarkShadow/);
assert.match(serverSource, /goodwin-benchmark-prospective-audit-v3|rawBenchmarkShadow\.auditVersion/);
assert.match(
  apiContractSource,
  /Number\(benchmarkShadow\?\.walkForward\?\.selectedRows \|\| 0\) === 0\s*\|\|\s*benchmarkShadow\?\.walkForward\?\.allFoldsStrictTimeOrder === true/
);

process.stdout.write(`${JSON.stringify({
  ok: true,
  verifier: "benchmark-selection-policy",
  version: GOODWIN_BENCHMARK_SHADOW_POLICY.version,
  checks: 24,
  criteria: qualified.criteria,
  role: GOODWIN_BENCHMARK_SHADOW_POLICY.role,
}, null, 2)}\n`);
