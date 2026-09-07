"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  FORMAL_REVIEW_PERFORMANCE_START_DATE,
  FORMAL_REVIEW_PERFORMANCE_VERSION,
  buildFormalReviewPerformance,
  compactFormalReviewPerformance,
  buildReferenceReviewPerformance,
  compactReferenceReviewPerformance,
  REFERENCE_REVIEW_PERFORMANCE_VERSION,
  matchIdentity,
} = require("../server/reviewPerformanceSummary.cjs");

const formalMatch = ({ id, date, status, track = "formal", action = "recommend", role = "main", marketType = "BEST" }) => ({
  id,
  sourceMatchId: id,
  businessDate: date,
  status: "FINISHED",
  postMatchReview: {
    predictionReview: {
      formalBestStatus: status,
      rows: [{
        marketType,
        performanceTrack: track,
        recommendationAction: action,
        reviewRole: role,
        resultStatus: status,
      }],
    },
  },
});

const rows = [
  formalMatch({ id: "before", date: "2026-08-15", status: "WON" }),
  formalMatch({ id: "a", date: "2026-08-16", status: "WON" }),
  formalMatch({ id: "b", date: "2026-08-16", status: "LOST" }),
  formalMatch({ id: "c", date: "2026-08-17", status: "WON" }),
  formalMatch({ id: "c", date: "2026-08-17", status: "WON" }),
  formalMatch({ id: "reference", date: "2026-08-17", status: "WON", track: "reference" }),
  formalMatch({ id: "live", date: "2026-08-17", status: "WON", track: "live-model" }),
  formalMatch({ id: "not-best", date: "2026-08-17", status: "WON", marketType: "1X2" }),
  formalMatch({ id: "not-main", date: "2026-08-17", status: "WON", role: "reference" }),
  formalMatch({ id: "not-recommend", date: "2026-08-17", status: "WON", action: "watch" }),
];

const summary = buildFormalReviewPerformance({
  matches: rows,
  generatedAt: "2026-08-17T12:00:00.000Z",
});

assert.equal(summary.version, FORMAL_REVIEW_PERFORMANCE_VERSION);
assert.equal(summary.startDate, FORMAL_REVIEW_PERFORMANCE_START_DATE);
assert.deepEqual(summary.cumulative, {
  date: null,
  won: 2,
  lost: 1,
  settled: 3,
  hitRate: 2 / 3,
});
assert.deepEqual(summary.daily, [
  { date: "2026-08-16", won: 1, lost: 1, settled: 2, hitRate: 0.5 },
  { date: "2026-08-17", won: 1, lost: 0, settled: 1, hitRate: 1 },
]);
assert.equal(summary.exclusions.beforeStart, 1);
assert.equal(summary.exclusions.duplicateEvent, 1);
assert.equal(summary.exclusions.withoutFrozenFormalSettlement, 5);

assert.deepEqual(compactFormalReviewPerformance(summary)?.cumulative, {
  won: 2,
  lost: 1,
  settled: 3,
  hitRate: 2 / 3,
});
assert.equal(compactFormalReviewPerformance({ ...summary, cumulative: { won: 2, lost: 1, settled: 4 } }), null);

const checks = Array.from({ length: 11 }, (_, i) => `legacy formal regression ${i + 1}`);
const check = (name, test) => { test(); checks.push(name); };
const referenceMatch = (options) => formalMatch({
  date: "2026-08-17", status: "WON", ...options,
  track: "reference", action: "reference", role: "reference",
});
const generate = (matches) => ({ matches, generatedAt: "2026-09-07T02:00:00Z" });
const clone = (value) => JSON.parse(JSON.stringify(value));

check("reference BEST excludes formal, live, provisional shadow, supporting markets and pending/void", () => {
  const ref = referenceMatch({ id: "reference-best" });
  const supporting = referenceMatch({ id: "supporting", marketType: "1X2" });
  const live = referenceMatch({ id: "live" });
  live.postMatchReview.predictionReview.rows[0].performanceTrack = "live-model";
  const shadow = clone(live);
  shadow.id = shadow.sourceMatchId = "shadow";
  shadow.postMatchReview.predictionReview.rows[0].performanceTrack = "shadow-provisional";
  const input = [ref, rows[1], live, shadow, supporting,
    referenceMatch({ id: "pending", status: "PENDING" }), referenceMatch({ id: "void", status: "VOID" })];
  const result = buildReferenceReviewPerformance(generate(input));
  assert.equal(result.version, REFERENCE_REVIEW_PERFORMANCE_VERSION);
  assert.equal(result.cumulative.settled, 1);
  assert.equal(result.cumulative.won, 1);
  assert.equal(result.policy.unit, "match-best");
  assert.equal(result.policy.sourceScope, "server-complete-history");
  assert.equal(buildFormalReviewPerformance(generate(input)).cumulative.settled, 1);
});

check("known numeric Sporttery aliases deduplicate consistently for both ledgers", () => {
  for (const [factory, aggregate] of [[referenceMatch, buildReferenceReviewPerformance], [formalMatch, buildFormalReviewPerformance]]) {
    const event = factory({ id: "sporttery_123", date: "2026-08-17", status: "WON" });
    event.sourceMatchId = 123;
    const duplicate = clone(event);
    duplicate.id = "123";
    duplicate.sourceMatchId = "sporttery_123";
    const fallback = clone(event);
    delete fallback.sourceMatchId;
    const fiveHundredAlias = { ...event, id: "fivehundred_123" };
    assert.equal(matchIdentity(event), matchIdentity(fallback));
    assert.equal(matchIdentity(event), matchIdentity(duplicate));
    assert.equal(matchIdentity(event), matchIdentity(fiveHundredAlias));
    assert.equal(matchIdentity({ ...event, id: "fivehundred_124" }), "");
    const result = aggregate(generate([event, fallback, duplicate, fiveHundredAlias]));
    assert.equal(result.cumulative.settled, 1);
    assert.equal(result.exclusions.duplicateEvent, 3);
  }
});

check("malformed legacy identities are excluded, never stringified or silently rescued", () => {
  const malformed = [{}, [], true, false, 0, -1, Number.MAX_SAFE_INTEGER + 1, "0", "001", "1.5", "NaN", "sporttery_0"];
  const input = malformed.map((sourceMatchId, i) => ({ ...referenceMatch({ id: `valid-fallback-${i}` }), sourceMatchId }));
  const result = buildReferenceReviewPerformance(generate(input));
  assert.equal(result.cumulative.settled, 0);
  assert.equal(result.cumulative.hitRate, null);
  assert.equal(result.exclusions.invalidIdentity, malformed.length);
  assert.equal(result.exclusions.duplicateEvent, 0);
});

check("provider namespaces, opaque IDs and event dates do not falsely coalesce", () => {
  const sporttery = { ...referenceMatch({ id: "sporttery_123" }), sourceMatchId: "123" };
  const external = { ...sporttery, id: "unknownprovider_123" };
  assert.notEqual(matchIdentity(sporttery), matchIdentity(external));
  assert.notEqual(matchIdentity(referenceMatch({ id: "opaque_a" })), matchIdentity(referenceMatch({ id: "a" })));
  const nextDay = { ...sporttery, businessDate: "2026-08-18" };
  assert.equal(buildReferenceReviewPerformance(generate([sporttery, external, nextDay])).cumulative.settled, 3);
  assert.equal(matchIdentity({ ...sporttery, id: "sporttery_124" }), "");
});

check("same official source/date with conflicting known event clocks excludes the entire event in any order", () => {
  for (const [factory, aggregate] of [[referenceMatch, buildReferenceReviewPerformance], [formalMatch, buildFormalReviewPerformance]]) {
    const first = { ...factory({ id: "sporttery_2041175", date: "2026-08-17", status: "WON" }), sourceMatchId: "2041175", kickoffTime: "2026-08-17T12:00:00Z" };
    const second = { ...clone(first), id: "fivehundred_2041175", eventVersion: "2026-08-17T13:00:00Z", kickoffTime: undefined };
    const legacy = { ...clone(first), kickoffTime: undefined };
    for (const input of [[first, second, legacy], [legacy, second, first], [second, first, legacy]]) {
      const result = aggregate(generate(input));
      assert.equal(result.cumulative.settled, 0);
      assert.equal(result.exclusions.conflictingEvent, 1);
      assert.equal(result.exclusions.duplicateEvent, 2);
    }
    assert.equal(aggregate(generate([first, legacy])).cumulative.settled, 1);
    assert.equal(aggregate(generate([legacy, first])).cumulative.settled, 1);
    const inconsistentRecord = { ...first, eventVersion: "2026-08-17T13:00:00Z" };
    assert.equal(aggregate(generate([inconsistentRecord])).cumulative.settled, 0);
  }
});

check("conflicting WON/LOST duplicate events fail closed independently of input order", () => {
  for (const [factory, aggregate] of [[referenceMatch, buildReferenceReviewPerformance], [formalMatch, buildFormalReviewPerformance]]) {
    const won = factory({ id: "conflict", date: "2026-08-17", status: "WON" });
    const lost = factory({ id: "conflict", date: "2026-08-17", status: "LOST" });
    const forward = aggregate(generate([won, lost, won]));
    const reverse = aggregate(generate([lost, won, won]));
    assert.deepEqual(forward, reverse);
    assert.equal(forward.cumulative.settled, 0);
    assert.equal(forward.cumulative.hitRate, null);
    assert.equal(forward.exclusions.conflictingEvent, 1);
  }
});

check("ambiguous BEST selections and void conflicts never pick the first winning row", () => {
  const event = referenceMatch({ id: "ambiguous" });
  event.postMatchReview.predictionReview.rows.push({ ...event.postMatchReview.predictionReview.rows[0], resultStatus: "LOST" });
  assert.equal(buildReferenceReviewPerformance(generate([event])).cumulative.settled, 0);
  const valid = referenceMatch({ id: "cancelled" });
  const voided = { ...clone(valid), resultDisposition: "VOID" };
  assert.deepEqual(buildReferenceReviewPerformance(generate([valid, voided])), buildReferenceReviewPerformance(generate([voided, valid])));
  assert.equal(buildReferenceReviewPerformance(generate([valid, voided])).cumulative.settled, 0);
});

check("strict track/action/role rejects mixed legacy membership", () => {
  const mixed = ["performanceTrack", "recommendationAction", "reviewRole"].map((field) => {
    const event = referenceMatch({ id: field });
    delete event.postMatchReview.predictionReview.rows[0][field];
    return event;
  });
  assert.equal(buildReferenceReviewPerformance(generate(mixed)).cumulative.settled, 0);
});

check("invalid dates are excluded and Shanghai fallback respects business day boundaries", () => {
  const malformed = { ...referenceMatch({ id: "bad-date" }), businessDate: "2026-02-31" };
  const fromKickoff = { ...referenceMatch({ id: "kickoff" }), businessDate: undefined, kickoffTime: "2026-08-16T17:00:00Z" };
  const result = buildReferenceReviewPerformance(generate([malformed, fromKickoff]));
  assert.equal(result.exclusions.invalidDate, 1);
  assert.equal(result.daily[0].date, "2026-08-17");
});

check("empty or wholly excluded cohorts have null hit rates, not 0 or 50 percent", () => {
  for (const aggregate of [buildReferenceReviewPerformance, buildFormalReviewPerformance]) {
    const empty = aggregate(generate([]));
    assert.deepEqual(empty.cumulative, { date: null, won: 0, lost: 0, settled: 0, hitRate: null });
    assert.deepEqual(empty.daily, []);
  }
  assert.equal(compactReferenceReviewPerformance(buildReferenceReviewPerformance(generate([]))).cumulative.hitRate, null);
});

const completeHistory = Array.from({ length: 1401 }, (_, i) => referenceMatch({ id: `complete-${i}`, status: i < 201 ? "WON" : "LOST" }));
const completeHistoryBeforeAggregation = JSON.stringify(completeHistory);
const completeSummary = buildReferenceReviewPerformance(generate(completeHistory));
check("complete server aggregation exceeds the 1200-row browser history cap without mutating frozen inputs", () => {
  assert.equal(completeSummary.cumulative.settled, 1401);
  assert.equal(completeSummary.cumulative.won, 201);
  assert.equal(completeSummary.cumulative.hitRate, 201 / 1401);
  assert.equal(buildReferenceReviewPerformance(generate(completeHistory.slice(-1200))).cumulative.won, 0);
  assert.equal(JSON.stringify(completeHistory), completeHistoryBeforeAggregation);
  assert.deepEqual(buildReferenceReviewPerformance(generate([...completeHistory].reverse())), completeSummary);
});

check("public compaction reconciles every count and rejects malformed/duplicate dates", () => {
  assert.equal(compactReferenceReviewPerformance(completeSummary).cumulative.settled, 1401);
  const badCounts = clone(completeSummary);
  badCounts.cumulative.won -= 1;
  badCounts.cumulative.lost += 1;
  assert.equal(compactReferenceReviewPerformance(badCounts), null);
  const badDate = clone(completeSummary);
  badDate.daily[0].date = "2026-02-31";
  assert.equal(compactReferenceReviewPerformance(badDate), null);
  const badType = clone(completeSummary);
  badType.cumulative.won = String(badType.cumulative.won);
  assert.equal(compactReferenceReviewPerformance(badType), null);
  const duplicateDate = clone(completeSummary);
  duplicateDate.daily.push({ date: duplicateDate.daily[0].date, won: 0, lost: 0, settled: 0 });
  assert.equal(compactReferenceReviewPerformance(duplicateDate), null);
  const missingPolicy = clone(completeSummary);
  delete missingPolicy.policy;
  assert.equal(compactReferenceReviewPerformance(missingPolicy), null);
  assert.equal(compactReferenceReviewPerformance({ ...completeSummary, version: FORMAL_REVIEW_PERFORMANCE_VERSION }), null);
});

const rootDir = path.resolve(__dirname, "..");
const pageSource = fs.readFileSync(path.join(rootDir, "src/pages/HitAndWin.tsx"), "utf8");
// Execute the actual TSX component with read-only React hooks; no browser,
// access code, network, or on-disk generated bundle is needed for this check.
let ts = null;
if (process.env.VERIFY_REVIEW_PERFORMANCE_SOURCE_ONLY !== "1") {
  try { ts = require("typescript"); }
  catch (error) { if (error?.code !== "MODULE_NOT_FOUND") throw error; }
}
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const compiledPage = ts ? ts.transpileModule(pageSource, { compilerOptions: {
  jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
} }).outputText : null;
const renderPage = (scorecard, matches = []) => {
  const module = { exports: {} };
  const fakeRequire = (id) => {
    if (id === "react") return { ...React, useMemo: (fn) => fn(), useState: (value) => [value, () => {}] };
    if (id === "react-router-dom") return { useNavigate: () => () => {} };
    if (id === "../context/AppContextCore") return { useApp: () => ({ language: "zh", matches, dataSync: { modelEvaluation: { publicScorecard: scorecard } } }) };
    if (id === "../services/entities") return { getTeamById: () => ({ shortName: { zh: "测试", en: "Fixture" } }) };
    if (id === "../components/predictions/DateScopeBar") return { DateScopeBar: () => null };
    return require(id);
  };
  new Function("require", "module", "exports", compiledPage)(fakeRequire, module, module.exports);
  return renderToStaticMarkup(React.createElement(module.exports.HitAndWin));
};

check("review page has a complete-source-only contract, neutral empty states and readable two-column cards", () => {
  for (const fragment of ["scorecard?.referenceReviewPerformance", "server-complete-history", "validReviewBucket(referenceReviewPerformance?.cumulative)", "统计待更新", "无已结算样本", "repeat(2, minmax(0, 1fr))", "fontSize: '13px'", "'22px' : '16px'", "命中 ${bucket.won} / 已结算 ${bucket.settled}"]) assert.ok(pageSource.includes(fragment), fragment);
  assert.ok(!pageSource.includes("allSystemReviewMatches.reduce"));
  assert.ok(!pageSource.includes("systemReviewSummary.referenceWon"));
});

if (ts) check("actual review UI renders complete server totals even with no browser history or partial history", () => {
  const scorecard = { referenceReviewPerformance: compactReferenceReviewPerformance(completeSummary), formalReviewPerformance: compactFormalReviewPerformance(buildFormalReviewPerformance(generate([]))) };
  for (const localRows of [[], completeHistory.slice(-1)]) {
    const html = renderPage(scorecard, localRows);
    assert.ok(html.includes("14.3%"));
    assert.ok(html.includes("命中 201 / 已结算 1401"));
    assert.ok(html.includes("server-complete-history"));
    assert.ok(html.includes("参考 BEST 累计"));
    assert.ok(html.includes("正式 BEST 累计"));
    assert.ok(html.includes("无已结算样本"));
    assert.ok(html.includes("命中 0 / 已结算 0"));
    assert.ok(html.includes("统计生成（北京时间）"));
  }
  assert.ok(!pageSource.includes("allSystemReviewMatches.reduce"));
});

if (ts) check("missing or old reference summary renders pending without inventing a local cumulative value", () => {
  const html = renderPage({}, completeHistory.slice(-1));
  assert.ok(html.includes("统计待更新"));
  assert.ok(!html.includes("0.0%"));
  assert.ok(!html.includes("50.0%"));
  const old = clone(completeSummary);
  old.policy.sourceScope = "browser-history";
  assert.ok(!renderPage({ referenceReviewPerformance: old }).includes("14.3%"));
});

console.log(JSON.stringify({
  ok: true,
  version: FORMAL_REVIEW_PERFORMANCE_VERSION,
  startDate: FORMAL_REVIEW_PERFORMANCE_START_DATE,
  referenceVersion: REFERENCE_REVIEW_PERFORMANCE_VERSION,
  uiVerification: ts ? "behavioral-tsx-and-source-contract" : "source-contract-only-dev-dependencies-unavailable",
  checks: checks.length,
  passed: checks.length,
  cases: checks,
}, null, 2));
