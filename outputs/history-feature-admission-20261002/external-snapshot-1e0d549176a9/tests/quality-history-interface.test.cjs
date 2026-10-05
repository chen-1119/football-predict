"use strict";
// Real artifact checks and adversarial in-memory mutations are separate from
// synthetic adapter probes. No writes to the evidence/implementation worktrees.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const crypto = require("node:crypto");
const { loadHistoryBundle, auditHistory } = require("../scripts/qualityHistoryRegressionEvidence.cjs");
const root = process.env.QUALITY_HISTORY_EVIDENCE_ROOT || path.resolve(__dirname, "../../05-history-regression");
const loaded = loadHistoryBundle(root, process.env.QUALITY_HISTORY_IMPLEMENTATION_ROOT || root);
const { bundle, interfaces } = loaded;
const baseline = auditHistory(bundle, interfaces.admission);
const clone = value => structuredClone(value);
const registryOptions = { collectorTrustRegistry: bundle.capture.collectorTrustRegistry, publication: bundle.capture.publication };
const validRaw = bundle.capture.rows.find(row => interfaces.admission.inspectRow(row, registryOptions).pairedEligible);
function changeReport(part, mutate) { const changed = { ...bundle, [part]: clone(bundle[part]) }; mutate(changed[part]); return changed; }
function rawBinding(capture) {
  const { transport, ...remote } = capture;
  const rawResponseBytes = Buffer.from(JSON.stringify(remote));
  capture.transport = { ...transport, responseByteSha256: crypto.createHash("sha256").update(rawResponseBytes).digest("hex") };
  return { rawResponseBytes, expectedPublication: bundle.prior.publication, expectedManifestFileSha256: bundle.prior.manifestFileSha256 };
}

test("real 05 receipt: file hashes, generation, admission, metrics and chronology pass independently", () => {
  assert.equal(baseline.ok, true); assert.equal(baseline.sourceRows, 432); assert.equal(baseline.frozenProbabilityRows, 180);
  assert.equal(baseline.pairedRows, 154); assert.deepEqual(baseline.trainingTimeValidRows, [0, 2]);
  assert.equal(baseline.published145Reproduced, false); assert.equal(baseline.prospectiveConfirmation, false);
  assert.equal(baseline.productionEligible, false); assert.equal(baseline.deploymentAuthorized, false);
});
for (const [name, part, mutate, expected] of [
  ["different event with unchanged row count", "review", value => { value.perMatch[0].matchId = "quality-other-event"; }, "paired-review-identical-events"],
  ["duplicate review snapshot counted independently", "review", value => { value.perMatch[1] = clone(value.perMatch[0]); }, "paired-review-identical-events"],
  ["different decision in market comparison", "review", value => { value.perMatch[0].decisionId = "quality-other-decision"; }, "model-market-same-row-probabilities-and-odds"],
  ["different market time in saved admission", "admission", value => { value.records[0].officialOdds.receivedAt = value.records[0].kickoffAt; }, "saved-admission-exactly-matches-revalidated-pairs"],
  ["different odds in saved paired sample", "admission", value => { value.records[0].officialOdds.sp.home += 0.5; }, "saved-admission-exactly-matches-revalidated-pairs"],
  ["missing frozen probability", "admission", value => { delete value.records[0].decision.probabilities.draw; }, "saved-admission-exactly-matches-revalidated-pairs"],
  ["excluded events silently removed from denominator", "summary", value => { value.coverage.denominator = 154; }, "paired-counts-and-coverage"],
  ["missing-data funnel reason changed", "summary", value => { value.funnel.primaryExclusions["frozen-decision-missing"]--; }, "complete-exclusion-funnel-reconciles"],
  ["model Brier altered", "review", value => { value.metrics.publishedModel.brier -= 0.01; }, "publishedModel-metrics-and-reliability-recomputed"],
  ["market log loss altered", "summary", value => { value.recomputedFrozenPair.metrics.sameDecisionMarket.logLoss += 0.01; }, "sameDecisionMarket-metrics-and-reliability-recomputed"],
  ["reliability bin inflated", "review", value => { value.metrics.publishedModel.reliability.home[0].n++; }, "publishedModel-metrics-and-reliability-recomputed"],
  ["paired confidence interval changed", "review", value => { value.pairedAgainstMarket.publishedModel.metrics.brier.interval[0] -= 0.01; }, "paired-bootstrap-metrics-recomputed"],
  ["154 relabeled as original strict 145", "summary", value => { value.historicalPublished145Reproduced = true; }, "154-not-claimed-as-published-145"],
  ["known history relabeled prospective", "protocol", value => { value.source.limitation = "untouched prospective evaluation"; }, "known-history-not-prospective-confirmation"],
  ["test event inserted in training membership", "replay", value => { value.folds[0].membership.train.push(clone(value.finalTest.perMatch[0])); }, "september-early-stage-event-sets-disjoint"],
  ["training result readiness backfilled", "replay", value => { value.folds[0].counts.train.used = 45; }, "september-early-train-chronology-membership"],
  ["insufficient training selects candidate", "replay", value => { value.selection.selectedCandidate = "quality-unqualified"; }, "insufficient-training-cannot-select-candidate"],
  ["final-test tuning claimed", "replay", value => { value.selection.finalTestUsedForSelection = true; }, "final-test-not-used-for-selection"],
  ["replay relabeled published achievement", "replay", value => { value.evaluationKinds.candidate = "original-frozen-prediction-review"; }, "review-replay-identity-separated"],
]) test(`independent report negative: ${name}`, () => {
  const result = auditHistory(changeReport(part, mutate), interfaces.admission);
  assert.equal(result.ok, false); assert.ok(result.blockers.includes(expected), JSON.stringify(result.blockers));
});

test("raw-response mutation cannot pass the saved transport proof", () => {
  const capture = clone(bundle.capture); capture.rows[0].match.scoreHome = 99;
  assert.throws(() => interfaces.admission.verifyEnvelope(capture, { rawResponseBytes: bundle.rawResponseBytes }), /CAPTURE_DIFFERS_FROM_RAW_RESPONSE/);
});
test("duplicate event remains rejected after rebinding transport bytes and changing snapshot ID", () => {
  const capture = clone(bundle.capture), duplicate = clone(capture.rows[0]);
  duplicate.snapshot.snapshotId = "quality-duplicate-snapshot"; capture.rows.push(duplicate);
  assert.throws(() => interfaces.admission.verifyEnvelope(capture, rawBinding(capture)), /DUPLICATE_MATCH_MARKET/);
});
for (const [name, mutate, reason] of [
  ["missing probability", row => { row.snapshot.decisionSnapshot.probabilities.HAD = null; }, "frozen-probabilities-invalid"],
  ["market provider time after cutoff", row => { row.snapshot.decisionSnapshot.markets.HAD.observedAt = row.match.kickoffTime; }, "clock-or-provider-attestation-rejected"],
  ["market receipt time after kickoff", row => { row.snapshot.decisionSnapshot.markets.HAD.receivedAt = "2026-10-01T00:00:00Z"; }, "clock-or-provider-attestation-rejected"],
  ["different-event wrapper", row => { row.snapshot.sourceMatchId = "quality-other-event"; }, "snapshot-wrapper-event-mismatch"],
  ["review phase reused as prematch", row => { row.snapshot.phase = "review"; }, "review-phase"],
]) test(`real-row negative: ${name}`, () => {
  const row = clone(validRaw); mutate(row); const inspected = interfaces.admission.inspectRow(row, registryOptions);
  assert.equal(inspected.pairedEligible, false); assert.ok(inspected.reasons.includes(reason), JSON.stringify(inspected.reasons));
});
test("changing result receipt to an earlier unproved time cannot silently become a training label", () => {
  const row = clone(validRaw); row.match.resultProvenance.observedAt = "2026-09-01T00:00:00Z";
  const inspected = interfaces.admission.inspectRow(row, registryOptions); assert.equal(inspected.pairedEligible, false);
});
test("same-match replay duplicate cannot inflate samples", () => {
  const duplicate = clone(bundle.admission.records[0]); duplicate.decision.id = "quality-second-snapshot";
  assert.throws(() => interfaces.replay.summarizePublishedHistory([...bundle.admission.records, duplicate]), /duplicate match\/market/);
});
test("admission and scoring leave frozen input bytes unchanged", () => {
  const before = crypto.createHash("sha256").update(JSON.stringify(validRaw)).digest("hex");
  interfaces.admission.inspectRow(validRaw, registryOptions);
  interfaces.replay.summarizePublishedHistory(bundle.admission.records, { bootstrap: { iterations: 200 } });
  assert.equal(crypto.createHash("sha256").update(JSON.stringify(validRaw)).digest("hex"), before);
});

function syntheticRows(featureName = "weather") {
  return Array.from({ length: 12 }, (_, i) => {
    const date = `2026-01-0${Math.floor(i / 3) + 1}`;
    return { matchId: `quality-synthetic-${i}`, market: "HAD", league: "QUALITY_SYNTHETIC_ONLY", cutoffAt: `${date}T11:00:00+08:00`,
      kickoffAt: `${date}T12:00:00+08:00`, decision: { id: `quality-decision-${i}`, modelVersion: "quality-synthetic-original", at: `${date}T10:00:00+08:00`, probabilities: { home: 0.5, draw: 0.3, away: 0.2 } },
      officialOdds: { sp: { home: 2, draw: 3, away: 4 } }, result: { outcome: "home", observedAt: `${date}T14:00:00+08:00` },
      features: { candidateEligible: true, values: { [featureName]: { value: 0.2, source: "QUALITY_SYNTHETIC_PROVIDER", payloadSha256: "a".repeat(64),
        providerObservedAt: `${date}T08:00:00+08:00`, observedAt: `${date}T08:00:00+08:00`, receivedAt: `${date}T08:01:00+08:00`, availableAt: `${date}T09:00:00+08:00` } } } };
  });
}
function syntheticOptions(featureName = "weather", seen = []) {
  return { timeZone: "Asia/Shanghai", folds: [{ id: "quality-synthetic", train: { start: "2026-01-01", end: "2026-01-02" },
    calibration: { start: "2026-01-02", end: "2026-01-03" }, validation: { start: "2026-01-03", end: "2026-01-04" } }],
    finalTest: { start: "2026-01-04", end: "2026-01-05" }, minimumRows: { training: 3, calibration: 3, validation: 3, finalTest: 3 },
    bootstrap: { iterations: 200 }, source: { fixture: "QUALITY_SYNTHETIC_ONLY_NOT_MODEL_IMPROVEMENT" },
    candidates: [{ id: "quality-input-probe", version: "1", implementationHash: "b".repeat(64), requiredFeatures: [featureName], requiresCalibration: true,
      fit(rows) { seen.push({ stage: "fit", rows }); return {}; }, calibrate(state, rows) { seen.push({ stage: "calibrate", rows }); return state; },
      predict(state, row) { seen.push({ stage: "predict", row }); return row.decision.probabilities; } }] };
}
function selected(report) { return report.selection.selectedCandidate === "quality-input-probe"; }
test("synthetic positive control: explicit valid feature adapter gets separated stage inputs without result in predict", () => {
  const seen = [], report = interfaces.replay.runHistoryRegressionReplay(syntheticRows(), syntheticOptions("weather", seen));
  assert.equal(selected(report), true); assert.equal(report.productionEligible, false);
  const train = new Set(seen.find(row => row.stage === "fit").rows.map(row => row.matchId));
  const calibration = new Set(seen.find(row => row.stage === "calibrate").rows.map(row => row.matchId));
  assert.ok([...train].every(id => !calibration.has(id)));
  assert.ok(seen.filter(row => row.stage === "predict").every(row => !Object.hasOwn(row.row, "result") && !Object.hasOwn(row.row, "resultObservedAt")));
});
test("synthetic known-good rejection: availableAt after decision is blocked", () => {
  const rows = syntheticRows(); for (const row of rows) row.features.values.weather.availableAt = row.kickoffAt;
  const report = interfaces.replay.runHistoryRegressionReplay(rows, syntheticOptions()); assert.equal(selected(report), false);
});
test("synthetic required rejection: future observed/received clocks cannot be hidden by an old availableAt", () => {
  const rows = syntheticRows(); for (const row of rows) {
    const feature = row.features.values.weather; feature.providerObservedAt = row.result.observedAt;
    feature.observedAt = row.result.observedAt; feature.receivedAt = row.result.observedAt;
  }
  const report = interfaces.replay.runHistoryRegressionReplay(rows, syntheticOptions());
  assert.equal(selected(report), false, "Future provider/receipt feature times passed through despite being later than decision, cutoff and kickoff");
});
for (const field of ["providerObservedAt", "receivedAt"]) test(`synthetic required rejection: missing feature ${field} is unavailable`, () => {
  const rows = syntheticRows(); for (const row of rows) {
    delete row.features.values.weather[field];
    if (field === "providerObservedAt") delete row.features.values.weather.observedAt;
  }
  const report = interfaces.replay.runHistoryRegressionReplay(rows, syntheticOptions());
  assert.equal(selected(report), false, `Missing ${field} was silently accepted as audited evidence`);
});
for (const featureName of ["resultObservedAt", "finalScore", "finalScoreHome", "closingOdds", "postMatchRating"]) test(`synthetic required rejection: result-derived feature name ${featureName}`, () => {
  const report = interfaces.replay.runHistoryRegressionReplay(syntheticRows(featureName), syntheticOptions(featureName));
  assert.equal(selected(report), false, `Forbidden derived feature ${featureName} entered the adapter and remained selectable`);
});
test("synthetic required rejection: missing candidateEligible must not grant audited feature authority", () => {
  const rows = syntheticRows(); for (const row of rows) delete row.features.candidateEligible;
  const report = interfaces.replay.runHistoryRegressionReplay(rows, syntheticOptions());
  assert.equal(selected(report), false, "Missing positive field-audit admission was treated as eligible");
});
test("synthetic required rejection: nonexistent dates cannot be silently normalized", () => {
  const row = clone(bundle.admission.records[0]); row.result.observedAt = "2026-09-31T15:00:00Z";
  assert.throws(() => interfaces.replay.summarizePublishedHistory([row]), /invalid|timestamp|date/i);
});
test("synthetic default sample minima stop the adapter rather than auto-promote", () => {
  const options = syntheticOptions(); delete options.minimumRows;
  const report = interfaces.replay.runHistoryRegressionReplay(syntheticRows(), options);
  assert.equal(selected(report), false); assert.equal(report.productionEligible, false); assert.equal(report.selection.selectedCandidate, null);
});
test("synthetic overlapping train/calibration windows are rejected", () => {
  const options = syntheticOptions(); options.folds[0].calibration.start = "2026-01-01";
  assert.throws(() => interfaces.replay.runHistoryRegressionReplay(syntheticRows(), options), /ordered and non-overlapping/);
});
test("synthetic final labels cannot retune validation selection", () => {
  const rows = syntheticRows(), original = interfaces.replay.runHistoryRegressionReplay(rows, syntheticOptions());
  for (const row of rows.slice(9)) row.result.outcome = "away";
  const changed = interfaces.replay.runHistoryRegressionReplay(rows, syntheticOptions());
  assert.deepEqual(changed.selection, original.selection);
  assert.notEqual(changed.finalTest.metrics["quality-input-probe"].logLoss, original.finalTest.metrics["quality-input-probe"].logLoss);
});
test("synthetic result observation time does not enter feature adapter input or prediction", () => {
  const rows = syntheticRows(), originalSeen = [], changedSeen = [];
  const original = interfaces.replay.runHistoryRegressionReplay(rows, syntheticOptions("weather", originalSeen));
  for (const row of rows.slice(9)) row.result.observedAt = "2026-01-05T14:00:00+08:00";
  const changed = interfaces.replay.runHistoryRegressionReplay(rows, syntheticOptions("weather", changedSeen));
  assert.deepEqual(changed.selection, original.selection);
  assert.deepEqual(changedSeen.filter(row => row.stage === "predict"), originalSeen.filter(row => row.stage === "predict"));
  assert.deepEqual(changed.finalTest.perMatch.map(row => row.predictions["quality-input-probe"]), original.finalTest.perMatch.map(row => row.predictions["quality-input-probe"]));
});
test("synthetic required rejection: feature availability one nanosecond after decision", () => {
  const rows = syntheticRows(); for (const row of rows) row.features.values.weather.availableAt = row.decision.at.replace("+08:00", ".000000001+08:00");
  assert.equal(selected(interfaces.replay.runHistoryRegressionReplay(rows, syntheticOptions())), false);
});
test("synthetic required rejection: receipt one nanosecond after declared availability", () => {
  const rows = syntheticRows(); for (const row of rows) {
    const feature = row.features.values.weather; feature.receivedAt = feature.availableAt.replace("+08:00", ".000000001+08:00");
  }
  assert.equal(selected(interfaces.replay.runHistoryRegressionReplay(rows, syntheticOptions())), false);
});
test("synthetic required rejection: observation one nanosecond after receipt", () => {
  const rows = syntheticRows(); for (const row of rows) {
    const feature = row.features.values.weather;
    feature.providerObservedAt = feature.receivedAt.replace("+08:00", ".000000001+08:00"); feature.observedAt = feature.providerObservedAt;
  }
  assert.equal(selected(interfaces.replay.runHistoryRegressionReplay(rows, syntheticOptions())), false);
});
test("synthetic positive control: equal nanosecond instants across time zones preserve original clock text", () => {
  const rows = syntheticRows(), seen = [];
  for (const row of rows) {
    row.decision.at = row.decision.at.replace("+08:00", ".000000001+08:00");
    row.features.values.weather.availableAt = row.decision.at.replace("T10:00:00", "T02:00:00").replace("+08:00", "Z");
  }
  const report = interfaces.replay.runHistoryRegressionReplay(rows, syntheticOptions("weather", seen));
  assert.equal(selected(report), true);
  assert.ok(seen.filter(row => row.stage === "predict").every(row => row.row.features.weather.availableAt.endsWith(".000000001Z")));
});
