"use strict";
const assert = require("node:assert/strict");
const b = require("./historicalAsOfFeatureBuilder.cjs");
const { buildDynamicGoalStrengthArtifact } = require("./dynamicGoalStrengthModel.cjs");
const run = () => {
  const passed = [], check = (name, fn) => { fn(); passed.push(name); };
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const events = Array.from({ length: 5 }, (_, i) => ({ sourceEventId: `admission-valid-${i}`,
    date: `2024-02-${24 + i}`, availableAt: `2024-02-${25 + i}T00:00:00.000Z`,
    homeTeamName: i % 2 ? "Beta" : "Alpha", awayTeamName: i % 2 ? "Alpha" : "Beta",
    scoreHome: i % 3, scoreAway: (i + 1) % 3 }));
  const valid = buildDynamicGoalStrengthArtifact(events);
  check("valid model and feature artifact bytes retain the pre-fix commitments", () => {
    assert.equal(valid.artifactHash, "6e13a12c870827abc5b26f84c8373684b2a35f08f35a06f30c6a226bb9261e59");
    assert.equal(valid.featureArtifact.artifactHash, "e3dccf3697becfbe01982c62b2c878db8c9b70bd2108b0e8451b16cfdc211cb6");
    assert.equal(valid.model.modelHash, "91022e7c3a5b593e50d6d98aecced09111b5f09791f72e166f3d1ba90253b55d");
    assert.equal(b.verifyHistoricalAsOfFeatureArtifact(valid.featureArtifact), true);
  });
  for (const bad of [null, false, true, "", " ", "0", [], {}, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    for (const side of ["scoreHome", "scoreAway"]) check(`reject ${side} value ${String(bad)} (${typeof bad})`, () => {
      assert.throws(() => b.normalizeHistoricalEvent({ ...events[0], [side]: bad }), error => error.code === "INVALID_LABEL");
    });
  }
  for (const bad of ["2026-02-30T12:00:00Z", "2026-02-29T12:00:00Z", "2026-04-31T12:00:00Z",
    "2026-03-01T24:00:00Z", "2026-03-01T12:00:00", "2026-03-01", 20260301, true, null, ""]) {
    check(`reject malformed result availability ${String(bad)}`, () => {
      assert.throws(() => b.normalizeHistoricalEvent({ ...events[0], availableAt: bad }), error => error.code === "INVALID_TIMESTAMP");
    });
  }
  check("an explicitly invalid primary clock cannot fall through to a later alias", () => {
    assert.throws(() => b.normalizeHistoricalEvent({ ...events[0], availableAt: "", resultAvailableAt: events[0].availableAt }));
  });
  check("explicit null in primary score cannot borrow an alternate score", () => {
    assert.throws(() => b.normalizeHistoricalEvent({ ...events[0], historicalOutcome: { homeGoals: null, awayGoals: 1 } }));
  });
  check("numeric score aliases and legal zoned timestamps remain supported", () => {
    const result = b.normalizeHistoricalEvent({ ...events[0], scoreHome: undefined, scoreAway: undefined,
      score: { home: 0, away: 1 }, availableAt: "2024-02-25T08:00:00+08:00" });
    assert.deepEqual(result, b.normalizeHistoricalEvent(events[0]));
  });
  const without = (value, key) => { const body = { ...value }; delete body[key]; return body; };
  // Rehash every affected commitment. Semantic invalidity must not become valid
  // merely because an artifact is internally hash-consistent.
  const rehash = (artifact) => {
    for (const label of artifact.labels) {
      const body = without(without(label, "eventCommitmentHash"), "labelHash");
      label.labelHash = b.stableHash(body);
      label.eventCommitmentHash = b.stableHash({ match: artifact.snapshots.find(s => s.sourceEventId === label.sourceEventId).match, label: body });
    }
    for (const snapshot of artifact.snapshots) snapshot.featureHash = b.stableHash(without(snapshot, "featureHash"));
    artifact.input.rootHash = b.stableHash(artifact.labels.map(l => `${l.sourceEventId}:${l.eventCommitmentHash}`).sort());
    artifact.watermark.featureRootHash = b.stableHash(artifact.snapshots.map(s => `${s.sourceEventId}:${s.featureHash}`));
    artifact.watermark.labelRootHash = b.stableHash(artifact.labels.map(l => `${l.sourceEventId}:${l.labelHash}`));
    artifact.artifactHash = b.stableHash(without(artifact, "artifactHash"));
    return artifact;
  };
  for (const [name, mutate] of [
    ["null score", a => { a.labels[0].score.home = null; }],
    ["boolean score", a => { a.labels[0].score.home = false; }],
    ["wrong outcome for actual score", a => { a.labels[0].outcome = "1"; }],
    ["non-parseable result clock", a => { a.labels[0].availableAt = "unknown"; }],
    ["impossible calendar result clock", a => { a.labels[0].availableAt = "2024-02-30T12:00:00.000Z"; }],
    ["invented consumed row count", a => { a.snapshots.at(-1).stateWatermark.consumedRows += 1; }],
    ["invented consumed batch root", a => { a.snapshots.at(-1).stateWatermark.consumedRootHash = "a".repeat(64); }],
    ["invented final result watermark", a => { a.watermark.maxConsumedAvailableAt = "unknown"; }],
    ["invented final consumed root", a => { a.watermark.consumedRootHash = "a".repeat(64); }],
  ]) check(`rehashing cannot legitimize ${name}`, () => {
    const bad = clone(valid.featureArtifact); mutate(bad);
    assert.equal(b.verifyHistoricalAsOfFeatureArtifact(rehash(bad)), false);
  });
  return { checks: passed.length, passed, productionDataTouched: false, validModelHashUnchanged: true };
};
if (require.main === module) console.log(JSON.stringify({ ok: true, ...run() }, null, 2));
module.exports = { run };
