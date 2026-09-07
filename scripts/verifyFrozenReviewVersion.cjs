"use strict";
const assert = require("node:assert/strict");
const { bindPublicReferenceDecision: bind } = require("../src/services/publicReferenceDecision.cjs");
const { digest } = require("../src/services/publicReferenceEvidence.cjs");
const { captureFrozenReviewVersion: capture, compactFrozenReviewVersion: compact, resolveFrozenReviewVersion: resolve } = require("../src/services/frozenReviewVersion.cjs");
const { buildArchivedPreMatchPrediction, buildPostMatchReview } = require("./syncData.cjs");
const { buildReferenceReviewPerformance: aggregate, compactReferenceReviewPerformance: compactSummary } = require("../server/reviewPerformanceSummary.cjs");
const clone = value => JSON.parse(JSON.stringify(value));
const generatedAt = "2026-09-07T15:00:00.000Z";
function fixture(id = "991003", modelVersion = "frozen-model-a", pool = "HAD", odds = 3.4) {
  const at = "2026-09-07T01:00:00.000Z";
  const source = { id: `sporttery_${id}`, sourceMatchId: id, status: "SCHEDULED", businessDate: "2026-09-07",
    kickoffTime: "2026-09-07T12:00:00.000Z", eventVersion: "2026-09-07T12:00:00.000Z", buyEndTime: "2026-09-07T11:55:00.000Z",
    homeTeamName: "SYNTHETIC HOME", awayTeamName: "SYNTHETIC AWAY",
    predictions: [{ marketType: "BEST", recommendationAction: "reference", oddsPoolCode: pool, tipCode: "X", odds, ...(pool === "HHAD" ? { handicapLine: -1 } : {}) }],
    predictionMeta: { generatedAt: at, decisionId: `synthetic-version-${id}`, modelVersion, policyVersion: "frozen-policy-a",
      featureSnapshot: { capturedAt: at, sourceMatchId: id, kickoffTime: "2026-09-07T12:00:00.000Z", modelInputs: {} } },
    probabilityModel: { version: modelVersion, generatedAt: at, oneXTwo: { final: { home: 35, draw: 40, away: 25 } } } };
  const published = bind(source, null, "2026-09-07T01:00:01.000Z");
  const match = { ...published, status: "FINISHED", scoreHome: 1, scoreAway: 1,
    resultProvenance: { provider: "sporttery", official: true, trusted: true, scoreHome: 1, scoreAway: 1 } };
  match.archivedPreMatchPrediction = buildArchivedPreMatchPrediction(match, new Map(), null, generatedAt);
  match.postMatchReview = buildPostMatchReview(match, generatedAt, new Map());
  assert.ok(match.postMatchReview);
  return match;
}
module.exports = { fixture };
if (require.main === module) {
  const checks = [];
  const check = (name, fn) => { fn(); checks.push(name); };
  const best = m => m.postMatchReview.predictionReview.rows.find(row => row.marketType === "BEST");
  const summary = matches => aggregate({ matches, generatedAt });
  check("actual public builder to archive to settlement retains bound version, not mutable metadata", () => {
    const m = fixture(), row = best(m), trace = row.frozenVersion;
    assert.ok(trace); assert.equal(trace.referenceHash, m.predictionMeta.publicReferenceDecision.contentHash);
    assert.equal(trace.modelVersion, "frozen-model-a"); assert.equal(row.resultStatus, "WON");
    m.predictionMeta.modelVersion = "new-private-model"; m.predictionMeta.policyVersion = "new-private-policy";
    assert.deepEqual(resolve(m, row), trace); assert.equal(summary([m]).versionBreakdown.groups[0].modelVersion, "frozen-model-a");
  });
  check("HAD and HHAD versions keep independent pools and original settlement counts", () => {
    const s = summary([fixture(), fixture("991004", "frozen-model-b", "HHAD")]);
    assert.equal(s.cumulative.settled, 2); assert.equal(s.cumulative.won, 1); assert.equal(s.cumulative.lost, 1);
    assert.equal(s.versionBreakdown.groups.length, 2);
    assert.equal(s.versionBreakdown.groups.find(g => g.modelVersion === "frozen-model-b").marketBreakdown.HHAD.cumulative.lost, 1);
    assert.equal(compactSummary(s).versionBreakdown.groups.length, 2);
  });
  check("legacy missing review version cannot be backfilled during a later refresh", () => {
    const m = fixture(); delete best(m).frozenVersion;
    const before = structuredClone(m.postMatchReview);
    const refreshed = buildPostMatchReview(m, generatedAt, new Map());
    assert.equal(refreshed.predictionReview.rows.find(r => r.marketType === "BEST").frozenVersion, undefined);
    assert.deepEqual(m.postMatchReview, before);
    assert.equal(summary([{ ...m, postMatchReview: refreshed }]).versionBreakdown.unknown.cumulative.settled, 1);
  });
  check("existing archive without version stays unchanged, even with a bound same-direction record", () => {
    const m = fixture(); delete m.archivedPreMatchPrediction.prediction.frozenVersion;
    const before = structuredClone(m.archivedPreMatchPrediction);
    assert.deepEqual(buildArchivedPreMatchPrediction(m, new Map(), null, generatedAt), before);
  });
  check("frozen version survives legitimate repeated review without mutation", () => {
    const m = fixture(), before = clone(best(m).frozenVersion);
    const reviewed = buildPostMatchReview(m, generatedAt, new Map());
    assert.deepEqual(reviewed.predictionReview.rows.find(r => r.marketType === "BEST").frozenVersion, before);
  });
  check("zero-SP reference keeps its own version on repeated review without becoming an official market", () => {
    const m = fixture("991007", "zero-sp-model", "HAD", 0), row = best(m);
    assert.ok(row.frozenVersion); assert.equal(row.recommendationAction, "reference");
    const repeated = buildPostMatchReview(m, generatedAt, new Map());
    assert.deepEqual(repeated.predictionReview.rows.find(r => r.marketType === "BEST").frozenVersion, row.frozenVersion);
  });
  for (const field of ["modelVersion", "policyVersion", "referenceHash", "evidenceHash", "featureHash", "modelHash", "decisionAt", "recordedAt", "selection"]) {
    check(`changed trace field rejected: ${field}`, () => {
      const m = fixture(), row = best(m); row.frozenVersion[field] = "tampered";
      assert.equal(compact(row.frozenVersion, row), null); assert.equal(summary([m]).versionBreakdown.groups.length, 0);
    });
  }
  check("self-rehashed forged version still fails comparison with original public content binding", () => {
    const m = fixture(), row = best(m); row.frozenVersion.modelVersion = "forged";
    const { contentHash, ...body } = row.frozenVersion; row.frozenVersion.contentHash = digest(body);
    assert.ok(compact(row.frozenVersion, row)); assert.equal(resolve(m, row), null);
  });
  check("invalid calendar and timezone-less trace clocks stay invalid even after rehash", () => {
    for (const clock of ["2026-02-31T01:00:00Z", "2026-09-07T01:00:00", "2026-09-07T24:00:00Z"]) {
      const m = fixture(), row = best(m), trace = row.frozenVersion;
      trace.decisionAt = clock; const { contentHash, ...body } = trace; trace.contentHash = digest(body);
      assert.equal(compact(trace, row), null);
    }
  });
  check("wrong event, absent reference and changed line or odds cannot claim the frozen version", () => {
    for (const mutate of [m => m.kickoffTime = "2026-09-08T12:00:00.000Z", m => delete m.predictionMeta.publicReferenceDecision,
      m => best(m).odds = 4, m => best(m).handicapLine = -2, m => best(m).tipCode = "1",
      m => best(m).performanceTrack = "formal"]) {
      const m = fixture(); mutate(m); assert.equal(resolve(m, best(m)), null);
    }
  });
  check("v1 or unbound public records do not invent version metadata", () => {
    const m = fixture(), record = m.predictionMeta.publicReferenceDecision;
    assert.equal(capture({ ...record, version: "public-reference-decision-v1" }, m, best(m)), null);
    assert.equal(capture({ ...record, evidenceBinding: null }, m, best(m)), null);
  });
  check("duplicate with missing or conflicting provenance stays in UNKNOWN in either order", () => {
    const m = fixture(), old = clone(m); delete best(old).frozenVersion;
    for (const rows of [[m, old], [old, m]]) {
      const s = summary(rows); assert.equal(s.cumulative.settled, 1); assert.equal(s.versionBreakdown.groups.length, 0);
      assert.equal(s.versionBreakdown.unknown.cumulative.settled, 1);
    }
    assert.deepEqual(summary([m, old]), summary([old, m]));
  });
  check("partition compaction rejects missing, duplicate or reallocated version counts", () => {
    for (const mutate of [s => delete s.versionBreakdown.unknown, s => s.versionBreakdown.groups.push(clone(s.versionBreakdown.groups[0])),
      s => s.versionBreakdown.groups[0].key = "forged", s => s.versionBreakdown.groups[0].cumulative.won++,
      s => s.versionBreakdown.groups[0].marketBreakdown.HAD.daily[0].date = "2026-09-06",
      s => s.versionBreakdown.scope = "current-model", s => delete s.marketBreakdown]) {
      const s = summary([fixture()]); mutate(s); assert.equal(compactSummary(s), null);
    }
  });
  check("legacy summary without optional version partition remains usable", () => {
    const s = summary([fixture()]); delete s.versionBreakdown;
    assert.equal(compactSummary(s).cumulative.settled, 1); assert.equal(compactSummary(s).versionBreakdown, undefined);
  });
  console.log(JSON.stringify({ ok: true, checks: checks.length, cases: checks }, null, 2));
}
