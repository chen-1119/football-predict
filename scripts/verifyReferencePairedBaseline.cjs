"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const load = require("./lib/loadReviewTsForVerification.cjs");
const { fixture, trust, auditAt } = require("./verifyPublicReferencePairs.cjs");
const { buildReferencePerformanceWithPairs: build, compactReferencePairedBaseline: compact } = require("../server/referencePairedBaseline.cjs");
const { compactReferenceReviewPerformance } = require("../server/reviewPerformanceSummary.cjs");
const root = path.resolve(__dirname, "..");
const { selectReferencePairedBaseline: select, selectReviewMarketWindow } = load(ts, path.join(root, "src/services/reviewDashboard.ts"));
const clone = v => JSON.parse(JSON.stringify(v));
function summary(fixtures, options = {}) {
  return build({ matches: fixtures.map(f => f.match), snapshotPayload: {
    publicReferenceDecisions: fixtures.map(f => f.record), publicReferenceEvidence: fixtures.map(f => f.entry),
  }, trustRegistry: trust.registry, generatedAt: auditAt, ...options });
}
const checks = [];
const check = (name, fn) => { fn(); checks.push(name); };
const rate = (s, window = "all", market = "HAD", key = "") => select(s, window, market, key);
try {
  const good = fixture(), loss = fixture({ id: "997702", scores: [2,1] });
  const hh = fixture({ id: "997703", pool: "HHAD", scores: [2,1] });
  const all = summary([good, loss, hh]);
  check("real full-history builder reconciles separate HAD and HHAD pairs", () => {
    assert.equal(all.cumulative.settled, 3); assert.equal(all.pairedBaseline.cells.length, 2);
    assert.deepEqual([rate(all).paired, rate(all).publishedWon, rate(all).baselineWon], [2,1,1]);
    assert.equal(rate(all, "all", "HHAD").publicHitRate, 1);
    assert.equal(rate(all, "all", "BEST").paired, 3);
  });
  check("server public compactor preserves only safe paired counts", () => {
    const s = clone(all); s.pairedBaseline.privateEvidence = { secret: "must-not-escape" };
    const publicValue = compactReferenceReviewPerformance(s);
    assert.deepEqual(publicValue.pairedBaseline, all.pairedBaseline);
    assert.ok(!JSON.stringify(publicValue.pairedBaseline).includes(good.record.contentHash));
  });
  check("missing original archive excludes pairs but preserves the original win denominator", () => {
    const s = summary([good, loss], { snapshotPayload: {} });
    assert.deepEqual(s.cumulative, all.marketBreakdown.HAD.cumulative);
    assert.deepEqual([rate(s).paired, rate(s).excluded, rate(s).publicHitRate, rate(s).baselineHitRate], [0,2,null,null]);
  });
  check("partial evidence pairs only the subset, not the complete historical hit rate", () => {
    const s = summary([good, loss], { snapshotPayload: { publicReferenceDecisions: [good.record], publicReferenceEvidence: [good.entry] } });
    assert.equal(selectReviewMarketWindow(s, "reference", "all", "HAD").counts.hitRate, .5);
    assert.deepEqual([rate(s).paired, rate(s).excluded, rate(s).publicHitRate, rate(s).baselineHitRate], [1,1,1,0]);
  });
  check("untraced version stays excluded and is not reassigned to the current model", () => {
    const f = clone(good); delete f.match.postMatchReview.predictionReview.rows.find(r => r.marketType === "BEST").frozenVersion;
    const s = summary([f]); assert.equal(s.pairedBaseline.cells[0].versionKey, "UNKNOWN");
    assert.equal(rate(s, "version", "HAD", "UNKNOWN").excluded, 1);
  });
  check("exact frozen version is required for version selection", () => {
    const key = all.versionBreakdown.groups[0].key;
    assert.equal(rate(all, "version", "BEST", key).paired, 3);
    assert.equal(rate(all, "version", "BEST", "current"), null);
    assert.equal(rate(all, "version", "BEST"), null);
  });
  check("7 and 30 day windows use publication day, not the browser clock", () => {
    const s = summary([good], { generatedAt: "2026-09-20T15:00:00.000Z" });
    assert.equal(rate(s, "7d").paired, 0); assert.equal(rate(s, "7d").baselineHitRate, null);
    assert.equal(rate(s, "30d").paired, 1);
  });
  check("empty complete history is valid but never fabricates 0 or 50 percent", () => {
    const s = summary([]); assert.equal(rate(s).paired, 0); assert.equal(rate(s).baselineHitRate, null);
  });
  check("current mutable prices cannot revise an original public paired outcome", () => {
    const changed = clone(good); changed.match.odds = { odds1: 99, oddsX: 1.01, odds2: 99 };
    assert.deepEqual(summary([changed]), summary([good]));
  });
  check("revoked source key excludes all pairs without changing original totals", () => {
    const s = summary([good, loss], { trustRegistry: {} }); assert.equal(rate(s).paired, 0); assert.equal(s.cumulative.settled, 2);
  });
  check("ties keep fixed home draw away order and expose the tie count", () => {
    const s = summary([fixture({ quote: { odds1: 3, oddsX: 3, odds2: 3 } })]);
    assert.equal(rate(s).tiedBaselineOdds, 1); assert.equal(rate(s).baselineWon, 0);
  });
  check("full reference input beyond the 1200-row API limit remains in the denominator", () => {
    const matches = Array.from({ length: 1205 }, (_, i) => {
      const m = clone(good.match); m.id = `sporttery_${800000+i}`; m.sourceMatchId = String(800000+i);
      delete m.postMatchReview.predictionReview.rows.find(r => r.marketType === "BEST").frozenVersion;
      return m;
    });
    const s = summary([], { matches });
    assert.equal(s.cumulative.settled, 1205); assert.equal(rate(s).excluded, 1205); assert.equal(rate(s).paired, 0);
  });
  check("duplicate aliases preserve one event and do not double the paired count", () => {
    const copy = clone(good.match); copy.id = good.match.sourceMatchId;
    const s = summary([good], { matches: [good.match, copy] });
    assert.equal(s.cumulative.settled, 1); assert.equal(rate(s).paired, 1);
  });
  check("conflicting settlement duplicates are excluded from both original and paired ledgers", () => {
    const copy = clone(good.match); copy.postMatchReview.predictionReview.rows.find(r => r.marketType === "BEST").resultStatus = "LOST";
    const s = summary([good], { matches: [good.match, copy] });
    assert.equal(s.cumulative.settled, 0); assert.equal(rate(s).paired, 0);
  });
  check("different frozen model labels cannot leak across version selections", () => {
    const next = fixture({ id: "997704", mutateSource: s => s.predictionMeta.modelVersion = "synthetic-next" });
    const s = summary([good, next]); assert.equal(s.versionBreakdown.groups.length, 2);
    for (const group of s.versionBreakdown.groups) assert.equal(rate(s, "version", "HAD", group.key).paired, 1);
  });
  for (const [name, mutate] of [
    ["count drift", p => p.cells[0].settledReferenceEvents++],
    ["negative count", p => p.cells[0].paired = -1],
    ["fractional count", p => p.cells[0].paired = .5],
    ["unsafe count", p => p.cells[0].paired = Number.MAX_SAFE_INTEGER+1],
    ["matrix drift", p => p.cells[0].publicOnly++],
    ["wrong market", p => p.cells[0].market = "OTHER"],
    ["wrong version", p => p.cells[0].versionKey = "a".repeat(64)],
    ["wrong day", p => p.cells[0].date = "2026-09-06"],
    ["duplicate cell", p => p.cells.push(clone(p.cells[0]))],
    ["omitted cell", p => p.cells.pop()],
    ["private cell data", p => p.cells[0].proof = "private"],
    ["clock mismatch", p => p.generatedAt = "2026-09-08T00:00:00Z"],
    ["false coverage", p => p.recommendationCoverage = 1],
    ["promotion claim", p => p.promotionEligible = true],
    ["parameter claim", p => p.parameterRevisionVerified = true],
    ["unrecognized policy", p => p.policyVersion = "v2"],
    ["different tie policy", p => p.tieOrder.reverse()],
    ["independent result claim", p => p.resultBoundary = "independent"],
  ]) check(`server and browser reject ${name} while the main hit rate survives`, () => {
    const s = clone(all); mutate(s.pairedBaseline);
    assert.equal(compact(s.pairedBaseline, all), null); assert.equal(rate(s), null);
    assert.equal(compactReferenceReviewPerformance(s).cumulative.settled, 3);
    assert.equal(selectReviewMarketWindow(s, "reference", "all", "HAD").counts.hitRate, .5);
  });
  check("invalid cells outside the chosen window are still rejected", () => {
    const s = summary([good], { generatedAt: "2026-09-20T15:00:00.000Z" }); s.pairedBaseline.cells[0].paired++;
    assert.equal(rate(s, "7d"), null);
  });
  check("missing optional ledger does not reconstruct a baseline from browser rows", () => {
    const s = clone(all); delete s.pairedBaseline; s.matches = [good.match]; assert.equal(rate(s), null);
  });
  check("formal and shadow views cannot borrow reference paired statistics", () => {
    const render = track => {
      let hook = 0;
      const { ReviewEvidenceOverview } = load(ts, path.join(root, "src/components/review/ReviewEvidenceOverview.tsx"), {
        react: { ...React, useState: () => [[track, "all", "HAD", ""][hook++], () => {}] },
      });
      return renderToStaticMarkup(React.createElement(ReviewEvidenceOverview, { language: "zh", reference: all }));
    };
    assert.ok(render("reference").includes("data-review-paired-rate"));
    for (const track of ["formal", "shadow"]) assert.ok(!render(track).includes("data-review-paired-rate"));
    assert.ok(render("reference").includes("不能直接与全量命中率比较"));
  });
  check("production generator uses full split history and original snapshot ledger", () => {
    const source = require("node:fs").readFileSync(path.join(root,"scripts/syncData.cjs"), "utf8");
    assert.match(source, /buildReferencePerformanceWithPairs\(\{\s*matches: split\.history,\s*generatedAt: capturedAt,\s*snapshotPayload: predictionSnapshotsPayload,\s*trustRegistry: COLLECTOR_TRUST_REGISTRY/s);
  });
  console.log(JSON.stringify({ ok: true, count: checks.length, checks }, null, 2));
} finally { trust.cleanup(); }
