"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { decisionCaptureDisposition } = require("../src/services/decisionObservation.cjs");
const { predictionSet, applyPredictionPersistence, finalizePublishedPredictionDecisions,
  appendPredictionSnapshots, predictionSnapshotRow } = require("./syncData.cjs");
const { isDecisionClockAuditEligible } = require("../src/services/decisionSnapshot.cjs");
const copy = (v) => structuredClone(v);
const digest = (v) => crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex");
let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log(`PASS ${name}`); };
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "decision-observations-"));
const capturedAt = new Date().toISOString();
const input = { id: "sporttery_reobservation-fixture", sourceMatchId: "reobservation-fixture",
  kickoffTime: new Date(Date.parse(capturedAt) + 8 * 3600000).toISOString(),
  buyEndTime: new Date(Date.parse(capturedAt) + 8 * 3600000 - 600000).toISOString(),
  status: "SCHEDULED", homeTeam: "Synthetic Home", awayTeam: "Synthetic Away", leagueName: "Synthetic League",
  oddsSource: "sporttery:HAD", oddsUpdatedAt: capturedAt, odds: { odds1: 2.1, oddsX: 3.4, odds2: 3.3 },
  formSnapshot: { sampleSize: 24, home: { sampleSize: 12, goalsForAvg: 1.92, goalsAgainstAvg: 1.08 },
    away: { sampleSize: 12, goalsForAvg: 2.25, goalsAgainstAvg: 1.17 } } };
try {
  // Exercise the real model functions, rather than advancing clocks on a cache.
  const calculated = { ...input, ...predictionSet(input) };
  const fresh = finalizePublishedPredictionDecisions([calculated], new Map(), capturedAt)[0];
  check("real computation creates current-cycle clocks", () => {
    assert.equal(decisionCaptureDisposition(fresh, capturedAt).fresh, true);
    assert.ok(fresh.probabilityModel.executionClock.events.length > 0);
    assert.ok(Date.parse(fresh.probabilityModel.generatedAt) >= Date.parse(capturedAt));
    assert.ok(Date.parse(fresh.predictionMeta.decisionGeneratedAt) >= Date.parse(fresh.probabilityModel.generatedAt));
  });
  const first = appendPredictionSnapshots(temp, [fresh], capturedAt);
  check("first real computation is captured once", () => {
    assert.equal(first.rows.length, 1); assert.equal(first.observations.length, 1);
    assert.equal(first.rows[0].capturedAt, capturedAt);
  });
  const historyFile = path.join(temp, "prediction-snapshots.json");
  fs.writeFileSync(historyFile, JSON.stringify(first));
  const original = digest(first.rows);
  const later = new Date(Date.parse(fresh.predictionMeta.decisionGeneratedAt) + 60000).toISOString();
  const repeated = appendPredictionSnapshots(temp, [fresh], later);
  check("cached decision creates only a separate observation", () => {
    assert.equal(repeated.rows.length, 1); assert.equal(digest(repeated.rows), original);
    assert.equal(repeated.observations.length, 0); assert.equal(repeated.decisionObservations.length, 1);
    assert.equal(repeated.decisionObservations[0].observedAt, later);
    assert.equal(repeated.decisionObservations[0].decisionAt, fresh.predictionMeta.decisionGeneratedAt);
    assert.equal(repeated.decisionObservations[0].promotionEligible, false);
  });
  check("missing historical row never causes a backdated replacement", () => {
    const empty = fs.mkdtempSync(path.join(temp, "empty-"));
    const payload = appendPredictionSnapshots(empty, [fresh], later);
    assert.equal(payload.rows.length, 0); assert.equal(payload.observations.length, 0);
    assert.equal(payload.decisionObservations[0].reason, "cached-decision-reobservation");
  });
  check("later phase does not mint another cached decision", () => {
    const inFinalPhase = new Date(Date.parse(input.kickoffTime) - 20 * 60000).toISOString();
    const payload = appendPredictionSnapshots(temp, [fresh], inFinalPhase);
    assert.equal(payload.rows.length, 1); assert.equal(digest(payload.rows), original);
    assert.equal(payload.observations.length, 0);
    assert.equal(payload.decisionObservations[0].observedAt, inFinalPhase);
  });
  check("same capture cannot overwrite a frozen row", () => {
    const changed = copy(fresh); changed.predictions[0].odds = 99;
    // No outer field may overwrite the original immutable snapshot.
    const payload = appendPredictionSnapshots(temp, [changed], capturedAt);
    assert.equal(digest(payload.rows), original);
  });
  check("new public decision cannot be minted from cached calculation", () => {
    const blocked = finalizePublishedPredictionDecisions([copy(fresh)], new Map(), later, { finalizedAt: later })[0];
    assert.deepEqual(blocked.predictions, []);
    assert.equal(blocked.predictionMeta.publicationGate.status, "blocked");
    assert.equal(blocked.predictionMeta.decisionId, undefined);
  });
  check("advance only decision clock is insufficient for a fresh computation", () => {
    const fake = copy(fresh); fake.predictionMeta.decisionGeneratedAt = later;
    assert.equal(decisionCaptureDisposition(fake, later).fresh, false);
  });
  for (const field of ["generatedAt", "unifiedPosterior"]) check(`missing ${field} cannot mint a new snapshot`, () => {
    const incomplete = copy(fresh); delete incomplete.probabilityModel[field];
    assert.equal(decisionCaptureDisposition(incomplete, capturedAt).fresh, false);
  });
  check("contradictory stored and model clocks fail closed", () => {
    const changed = copy(fresh); changed.predictionMeta.modelGeneratedAt = later;
    assert.equal(decisionCaptureDisposition(changed, capturedAt).reason, "decision-computation-clock-inconsistent");
  });
  check("legacy invalid-clock record is not repaired or promoted", () => {
    const invalid = predictionSnapshotRow(fresh, later);
    assert.equal(isDecisionClockAuditEligible(invalid.decisionSnapshot), false);
    fs.writeFileSync(historyFile, JSON.stringify({ rows: [invalid] }));
    const payload = appendPredictionSnapshots(temp, [fresh], later);
    assert.equal(digest(payload.rows), digest([invalid]));
    assert.equal(isDecisionClockAuditEligible(payload.rows[0].decisionSnapshot), false);
  });
  check("cached persistence retains computation and input timestamps", () => {
    const again = applyPredictionPersistence(copy(fresh), copy(fresh), later, { finalizedAt: later });
    for (const key of ["generatedAt", "decisionGeneratedAt", "modelGeneratedAt", "unifiedPosteriorGeneratedAt",
      "syncCapturedAt", "publicationFinalizedAt", "updatedAt", "featureSnapshotHash", "decisionId", "decisionRevision"]) {
      assert.deepEqual(again.predictionMeta[key], fresh.predictionMeta[key], key);
    }
    assert.deepEqual(again.predictionMeta.featureSnapshot, fresh.predictionMeta.featureSnapshot);
    assert.deepEqual(again.probabilityModel, fresh.probabilityModel);
    assert.equal(again.predictionMeta.observedAt, later);
  });
  check("reobservation replay is deduplicated independently of frozen rows", () => {
    fs.writeFileSync(historyFile, JSON.stringify(repeated));
    const payload = appendPredictionSnapshots(temp, [fresh], later);
    assert.equal(payload.decisionObservations.length, 1); assert.equal(digest(payload.rows), original);
  });
  check("new prospective lane actually executes the model again", () => {
    const nextCapture = new Date().toISOString();
    const recomputed = { ...input, ...predictionSet(input) };
    const next = finalizePublishedPredictionDecisions([recomputed], new Map(), nextCapture)[0];
    assert.equal(decisionCaptureDisposition(next, nextCapture).fresh, true);
    const payload = appendPredictionSnapshots(temp, [fresh], nextCapture, { observationMatches: [next] });
    assert.equal(payload.observations.length, 1);
    assert.equal(payload.observations[0].decisionAt, next.predictionMeta.decisionGeneratedAt);
    assert.equal(digest(payload.rows.find((r) => r.capturedAt === capturedAt)), digest(first.rows[0]));
  });
  console.log(JSON.stringify({ ok: true, checks, productionDataTouched: false, providerRequests: 0,
    modelImprovementEstablished: false, source: "synthetic-input-real-calculation" }, null, 2));
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
