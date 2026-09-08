"use strict";
const assert = require("node:assert/strict");
const { fixture } = require("./verifyFrozenReviewVersion.cjs");
const { applyPredictionPersistence, finalizePublishedPredictionDecisions } = require("./syncData.cjs");
const at = "2026-09-08T02:00:00.000Z";
function verifyFrozenArchivePersistence() {
  let checks = 0;
  const check = fn => { fn(); checks++; };
  for (const pool of ["HAD", "HHAD"]) for (const odds of [0, 3.4]) check(() => {
    const old = fixture("991133", "original", pool, odds);
    const fresh = structuredClone(old);
    delete fresh.archivedPreMatchPrediction;
    const oldBytes = JSON.stringify(old), freshBytes = JSON.stringify(fresh);
    const result = applyPredictionPersistence(fresh, old, at);
    assert.deepEqual(result.archivedPreMatchPrediction, old.archivedPreMatchPrediction,
      "fresh result rows must inherit the exact validated archive, not rebuild it from retained snapshots");
    const finalized = finalizePublishedPredictionDecisions([fresh], new Map([["991133", old]]), at, at)[0];
    assert.deepEqual(finalized.archivedPreMatchPrediction, old.archivedPreMatchPrediction);
    assert.equal(JSON.stringify(old), oldBytes);
    assert.equal(JSON.stringify(fresh), freshBytes);
  });
  for (const mutate of [
    m => { m.kickoffTime = m.eventVersion = "2026-09-08T12:00:00Z"; },
    m => { m.sourceMatchId = "991134"; m.id = "sporttery_991134"; },
    m => { m.buyEndTime = "2026-09-07T00:00:00Z"; m.predictionMeta.cutoffTime = m.buyEndTime; },
  ]) check(() => {
    const old = fixture("991133"), fresh = structuredClone(old);
    delete fresh.archivedPreMatchPrediction; mutate(fresh);
    assert.equal(applyPredictionPersistence(fresh, old, at).archivedPreMatchPrediction, undefined);
  });
  check(() => {
    const old = fixture("991133"), fresh = structuredClone(old);
    old.archivedPreMatchPrediction.capturedAt = "2026-09-07T13:00:00Z";
    delete fresh.archivedPreMatchPrediction;
    assert.equal(applyPredictionPersistence(fresh, old, at).archivedPreMatchPrediction, undefined);
  });
  check(() => {
    const old = fixture("991133"), fresh = structuredClone(old);
    fresh.archivedPreMatchPrediction.prediction.tipCode = "1";
    assert.deepEqual(applyPredictionPersistence(fresh, old, at).archivedPreMatchPrediction,
      old.archivedPreMatchPrediction, "fresh derived archives cannot replace the first persisted archive");
  });
  check(() => {
    const fresh = fixture("991133"); delete fresh.archivedPreMatchPrediction;
    assert.equal(finalizePublishedPredictionDecisions([fresh], new Map(), at, at)[0].archivedPreMatchPrediction,
      undefined, "prospective computation must not acquire an invented archive");
  });
  return { ok: true, checks, productionWrites: 0 };
}
module.exports = { verifyFrozenArchivePersistence };
if (require.main === module) console.log(JSON.stringify(verifyFrozenArchivePersistence(), null, 2));
