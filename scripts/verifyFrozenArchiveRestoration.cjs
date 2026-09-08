"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const restoration = require("./frozenArchiveRestoration.cjs");
const { attachArchivedPreMatchPredictions, validArchivedPreMatchPrediction, finalizePublishedPredictionDecisions } = require("./syncData.cjs");
const payload = JSON.parse(fs.readFileSync(restoration.DEFAULT_PATH, "utf8"));
const index = restoration.validateManifest(payload);
const at = new Date(Date.parse(payload.observedLoss.checkedAt) + 60 * 60 * 1000).toISOString();
const matchFor = row => ({ ...row.identity, status: "FINISHED", scoreHome: 1, scoreAway: 1,
  predictionMeta: { generatedAt: at }, predictions: [] });
function verifyFrozenArchiveRestoration() {
  let checks = 0;
  const check = fn => { fn(); checks++; };
  assert.equal(index.size, 601);
  assert.equal(payload.baseline.archiveRootHash, "dd5d5325cfcafb3f704fef96ba25d47c963a345887a24632c07f71efda9bc3fa");
  assert.equal(payload.restorationScope, restoration.RESTORATION_SCOPE);
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
      const again = attachArchivedPreMatchPredictions([published], { rows: [] }, null, new Date(Date.parse(at) + 86400000).toISOString())[0];
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
      for (const mutate of [m => { m.sourceMatchId += "9"; }, m => { m.eventVersion = new Date(Date.parse(m.eventVersion) + 3600000).toISOString(); },
        m => { m.kickoffTime = new Date(Date.parse(m.kickoffTime) + 3600000).toISOString(); }, m => { m.homeTeamName += " DIFFERENT"; },
        m => { m.buyEndTime = "2026-01-01T00:00:00Z"; }]) {
        const wrong = structuredClone(match); mutate(wrong);
        assert.strictEqual(restoration.restoreMissingArchive(wrong, index, at, validArchivedPreMatchPrediction), wrong);
      }
    });
  }
  for (const mutate of [
    p => { p.rows[0].archive.prediction.tipCode = p.rows[0].archive.prediction.tipCode === "X" ? "1" : "X"; },
    p => { p.baseline.records[0].archiveSha256 = "0".repeat(64); },
    p => { p.observedLoss.checkedAt = p.baseline.checkedAt; },
    p => { p.rows[0].identity.sourceMatchId = "unknown"; },
    p => { p.rows.push(structuredClone(p.rows[0])); },
    p => { p.backup.stable = false; },
    p => { p.rows.pop(); },
    p => { delete p.backup.currentSha256; },
    p => { p.restorationScope = "observed-loss-only"; },
    p => { p.observedLoss.sourceMatchIds.push("not-in-original-baseline"); },
    p => { p.observedLoss.sourceMatchIds.push(p.observedLoss.sourceMatchIds[0]); },
  ]) check(() => {
    const bad = structuredClone(payload); mutate(bad);
    delete bad.integritySha256; bad.integritySha256 = restoration.digest(bad);
    assert.throws(() => restoration.validateManifest(bad));
  });
  check(() => { const bad = structuredClone(payload); bad.integritySha256 = "0".repeat(64); assert.throws(() => restoration.validateManifest(bad)); });
  check(() => {
    const newlyOmitted = payload.rows.find(row => !payload.observedLoss.sourceMatchIds.includes(row.identity.sourceMatchId));
    assert.ok(newlyOmitted, "fixture must cover an original not missing at preparation time");
    const match = matchFor(newlyOmitted);
    const later = attachArchivedPreMatchPredictions([match], { rows: [] }, null, new Date(Date.parse(at) + 86400000).toISOString())[0];
    assert.equal(restoration.digest(later.archivedPreMatchPrediction), newlyOmitted.archiveSha256);
    assert.deepEqual(later.predictions, []);
  });
  return { ok: true, checks, restoredFixtureObjects: index.size, baselineRows: payload.baseline.rows,
    restorationScope: restoration.RESTORATION_SCOPE, laterBaselineOmissionCovered: true,
    productionWrites: 0, formalRecommendationsCreated: 0 };
}
module.exports = { verifyFrozenArchiveRestoration };
if (require.main === module) console.log(JSON.stringify(verifyFrozenArchiveRestoration(), null, 2));
