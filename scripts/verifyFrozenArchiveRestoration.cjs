"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const restoration = require("./frozenArchiveRestoration.cjs");
const { attachArchivedPreMatchPredictions, validArchivedPreMatchPrediction, finalizePublishedPredictionDecisions } = require("./syncData.cjs");
const payload = JSON.parse(fs.readFileSync(restoration.DEFAULT_PATH, "utf8"));
const index = restoration.validateManifest(payload);
const at = "2026-09-08T03:00:00.000Z";
const matchFor = row => ({ ...row.identity, status: "FINISHED", scoreHome: 1, scoreAway: 1,
  predictionMeta: { generatedAt: at }, predictions: [] });
function verifyFrozenArchiveRestoration() {
  let checks = 0;
  const check = fn => { fn(); checks++; };
  assert.equal(index.size, 8);
  for (const row of payload.rows) {
    check(() => {
      const match = matchFor(row), before = JSON.stringify(match);
      const restored = restoration.restoreMissingArchive(match, index, at, validArchivedPreMatchPrediction);
      assert.equal(restoration.digest(restored.archivedPreMatchPrediction), row.archiveSha256);
      assert.equal(JSON.stringify(match), before);
      assert.deepEqual(restored.predictions, []);
      assert.equal(restored.predictionMeta.frozenArchiveRestoration.originalArchiveSha256, row.archiveSha256);
      const published = attachArchivedPreMatchPredictions([match], { rows: [] }, null, at)[0];
      assert.equal(restoration.digest(published.archivedPreMatchPrediction), row.archiveSha256);
      assert.deepEqual(published.predictions, []);
      const again = attachArchivedPreMatchPredictions([published], { rows: [] }, null, "2026-09-09T03:00:00Z")[0];
      assert.deepEqual(again.archivedPreMatchPrediction, published.archivedPreMatchPrediction);
      assert.deepEqual(again.predictionMeta.frozenArchiveRestoration, published.predictionMeta.frozenArchiveRestoration);
      const fresh = matchFor(row);
      const persisted = finalizePublishedPredictionDecisions([fresh], new Map([[row.identity.sourceMatchId, published]]), at, at)[0];
      assert.deepEqual(persisted.predictionMeta.frozenArchiveRestoration, published.predictionMeta.frozenArchiveRestoration);
      assert.equal(restoration.digest(persisted.archivedPreMatchPrediction), row.archiveSha256);
      const tampered = structuredClone(published); tampered.predictionMeta.frozenArchiveRestoration.originalArchiveSha256 = "0".repeat(64);
      assert.equal(restoration.retainedRestorationReceipt(persisted, tampered, index, at), null);
    });
    check(() => {
      const match = matchFor(row);
      const existing = { ...match, archivedPreMatchPrediction: { intentionally: "different-existing-evidence" } };
      assert.strictEqual(restoration.restoreMissingArchive(existing, index, at, validArchivedPreMatchPrediction), existing);
      assert.strictEqual(restoration.restoreMissingArchive(match, index, payload.backup.capturedAt, validArchivedPreMatchPrediction), match);
      for (const mutate of [m => { m.sourceMatchId += "9"; }, m => { m.eventVersion = "2026-07-01T00:00:00Z"; },
        m => { m.kickoffTime = "2026-07-01T00:00:00Z"; }, m => { m.homeTeamName += " DIFFERENT"; },
        m => { m.buyEndTime = "2026-01-01T00:00:00Z"; }]) {
        const wrong = structuredClone(match); mutate(wrong);
        assert.strictEqual(restoration.restoreMissingArchive(wrong, index, at, validArchivedPreMatchPrediction), wrong);
      }
    });
  }
  for (const mutate of [
    p => { p.rows[0].archive.prediction.tipCode = "X"; },
    p => { p.baseline.records[0].archiveSha256 = "0".repeat(64); },
    p => { p.observedLoss.checkedAt = p.baseline.checkedAt; },
    p => { p.rows[0].identity.sourceMatchId = "unknown"; },
    p => { p.rows.push(structuredClone(p.rows[0])); },
    p => { p.backup.stable = false; },
  ]) check(() => {
    const bad = structuredClone(payload); mutate(bad);
    delete bad.integritySha256; bad.integritySha256 = restoration.digest(bad);
    assert.throws(() => restoration.validateManifest(bad));
  });
  check(() => { const bad = structuredClone(payload); bad.integritySha256 = "0".repeat(64); assert.throws(() => restoration.validateManifest(bad)); });
  return { ok: true, checks, restoredFixtureObjects: 8, baselineRows: payload.baseline.rows,
    productionWrites: 0, formalRecommendationsCreated: 0 };
}
module.exports = { verifyFrozenArchiveRestoration };
if (require.main === module) console.log(JSON.stringify(verifyFrozenArchiveRestoration(), null, 2));
