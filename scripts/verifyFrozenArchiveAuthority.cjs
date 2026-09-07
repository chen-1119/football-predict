"use strict";
const assert = require("node:assert/strict");
const { fixture } = require("./verifyFrozenReviewVersion.cjs");
const { buildImmutableAnalysisReferenceDecision, verifyImmutableAnalysisReferenceDecision } = require("../src/services/immutableAnalysisReferenceDecision.cjs");
const { buildArchivedPreMatchPrediction, canonicalArchiveBestPrediction, validArchivedPreMatchPrediction } = require("./syncData.cjs");
const at = "2026-09-07T15:00:00.000Z";
function conflictingLegacy(pool = "HAD", odds = 3.4) {
  const match = fixture("991088", "original-frozen-version", pool, odds);
  delete match.predictionMeta.publicReferenceDecision;
  const source = { ...structuredClone(match), status: "SCHEDULED",
    odds: { odds1: 2, oddsX: 4, odds2: 4 }, oddsSource: "500.com:HAD", oddsUpdatedAt: "2026-09-07T02:00:00Z",
    probabilityModel: { inputSufficiency: { sufficient: false } } };
  const decision = buildImmutableAnalysisReferenceDecision(source, "2026-09-07T02:01:00Z");
  assert.ok(decision); assert.equal(decision.code, "1");
  match.predictionMeta.immutableAnalysisReferenceDecision = decision;
  assert.equal(verifyImmutableAnalysisReferenceDecision(decision, match).valid, true);
  assert.equal(canonicalArchiveBestPrediction(match).source, "immutable-analysis-reference-decision");
  return match;
}
function verifyFrozenArchiveAuthority() {
  let checks = 0;
  const check = fn => { fn(); checks++; };
  for (const [pool, odds] of [["HAD", 3.4], ["HAD", 0], ["HHAD", 3.4], ["HHAD", 0]]) check(() => {
    const match = conflictingLegacy(pool, odds), before = JSON.stringify(match), frozen = JSON.stringify(match.archivedPreMatchPrediction);
    assert.ok(validArchivedPreMatchPrediction(match));
    const result = buildArchivedPreMatchPrediction(match, new Map(), null, at);
    assert.equal(JSON.stringify(result), frozen, "unbound legacy market reference must not overwrite a frozen archive");
    assert.equal(JSON.stringify(match), before, "archive operation must not mutate its input");
    const again = buildArchivedPreMatchPrediction({ ...match, archivedPreMatchPrediction: result }, new Map(), null, "2026-09-08T15:00:00Z");
    assert.equal(JSON.stringify(again), frozen);
  });
  check(() => {
    const match = conflictingLegacy();
    delete match.predictionMeta.immutableAnalysisReferenceDecision;
    match.predictions[0].tipCode = "1";
    match.predictionMeta.decisionRevision = 1;
    match.predictionMeta.featureSnapshotHash = "a".repeat(64);
    match.predictionMeta.featureSnapshot.hash = "a".repeat(64);
    assert.equal(canonicalArchiveBestPrediction(match).source, "trusted-pre-cutoff-decision");
    assert.deepEqual(buildArchivedPreMatchPrediction(match, new Map(), null, at), match.archivedPreMatchPrediction,
      "a timestamped private model declaration is not authority to rewrite a frozen public archive");
  });
  check(() => {
    const match = conflictingLegacy();
    match.archivedPreMatchPrediction.prediction.tipCode = "1";
    const before = structuredClone(match.archivedPreMatchPrediction);
    assert.deepEqual(buildArchivedPreMatchPrediction(match, new Map(), null, at), before, "same-direction archive stays byte-stable");
  });
  check(() => {
    const match = fixture("991089");
    match.archivedPreMatchPrediction.prediction.tipCode = "1";
    const result = buildArchivedPreMatchPrediction(match, new Map(), null, at);
    assert.equal(result.prediction.tipCode, "X");
    assert.equal(result.recoveryEvidence.source, "public-reference-decision", "actual independent public evidence retains its repair authority");
  });
  check(() => {
    const match = conflictingLegacy();
    delete match.archivedPreMatchPrediction.prediction.frozenVersion;
    const before = JSON.stringify(match.archivedPreMatchPrediction);
    assert.equal(JSON.stringify(buildArchivedPreMatchPrediction(match, new Map(), null, at)), before,
      "older archives without version metadata keep the same overwrite protection");
  });
  check(() => {
    const match = conflictingLegacy();
    delete match.archivedPreMatchPrediction;
    const result = buildArchivedPreMatchPrediction(match, new Map(), null, at);
    assert.equal(result.prediction.tipCode, "1", "initial legacy reconstruction is outside the existing-archive correction guard");
    assert.equal(result.recoveryEvidence, undefined, "initial reconstruction must not invent a correction");
  });
  check(() => {
    const recovery = require("./archivedPreMatchRecovery.cjs");
    const index = recovery.loadArchivedPreMatchRecoveries(recovery.DEFAULT_RECOVERY_PATH);
    const match = { id: "sporttery_2040641", sourceMatchId: "2040641", status: "FINISHED",
      kickoffTime: "2026-07-28T01:00:00+08:00", eventVersion: "2026-07-28T01:00:00+08:00",
      buyEndTime: "2026-07-27T22:00:00+08:00" };
    const authorized = recovery.recoveryArchiveForMatch(match, index);
    assert.ok(authorized);
    match.archivedPreMatchPrediction = structuredClone(authorized);
    match.archivedPreMatchPrediction.prediction.tipCode = "1";
    assert.deepEqual(buildArchivedPreMatchPrediction(match, new Map(), null, at), authorized,
      "explicit integrity-checked release recovery stays distinct from unbound references");
  });
  return { ok: true, checks, productionWrites: false, historyRewritten: false };
}
module.exports = { verifyFrozenArchiveAuthority, conflictingLegacy };
if (require.main === module) console.log(JSON.stringify(verifyFrozenArchiveAuthority(), null, 2));
