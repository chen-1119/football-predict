"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  buildHistoricalAsOfFeatureArtifact,
  stableHash,
  verifyHistoricalAsOfFeatureArtifact,
} = require("./historicalAsOfFeatureBuilder.cjs");
const {
  DYNAMIC_GOAL_STRENGTH_MODEL_VERSION,
  DYNAMIC_GOAL_STRENGTH_WALK_FORWARD_VERSION,
  buildDynamicGoalStrengthArtifact,
  dixonColesScoreMatrix,
  evaluateDynamicGoalStrengthWalkForward,
  outcomeProbabilitiesFromMatrix,
  probabilityAudit,
  verifyDynamicGoalStrengthArtifact,
  verifyDynamicGoalStrengthWalkForward,
} = require("./dynamicGoalStrengthModel.cjs");

const DAY_MS = 24 * 60 * 60 * 1000;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const START_MS = Date.parse("2024-01-01T00:00:00.000Z");

const clone = (value) => JSON.parse(JSON.stringify(value));
const without = (value, key) => {
  const body = { ...value };
  delete body[key];
  return body;
};

function syntheticEvents(days = 54) {
  const teams = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel"];
  const rows = [];
  for (let day = 0; day < days; day += 1) {
    const dateMs = START_MS + day * DAY_MS;
    const date = new Date(dateMs).toISOString().slice(0, 10);
    for (let match = 0; match < 3; match += 1) {
      const homeIndex = (day + match * 2) % teams.length;
      let awayIndex = (day * 3 + match * 2 + 3) % teams.length;
      if (awayIndex === homeIndex) awayIndex = (awayIndex + 1) % teams.length;
      const home = teams[homeIndex];
      const away = teams[awayIndex];
      const strengthEdge = homeIndex - awayIndex;
      const homeGoals = Math.max(0, Math.min(4, 1 + ((day + match) % 3) + (strengthEdge < -3 ? 0 : 1)));
      const awayGoals = Math.max(0, Math.min(4, (day + awayIndex + match) % 3 + (strengthEdge < 0 ? 1 : 0)));
      rows.push({
        sourceEventId: `event-${String(day).padStart(3, "0")}-${match}`,
        sourceDataset: "synthetic/historical-strength-verifier",
        competition: day % 3 === 0 ? "L2" : "L1",
        date,
        homeTeam: { raw: home, normalized: home.toLowerCase() },
        awayTeam: { raw: away, normalized: away.toLowerCase() },
        historicalOutcome: { homeGoals, awayGoals },
        availableAt: new Date(dateMs + 2 * DAY_MS + 6 * 60 * 60 * 1000).toISOString(),
      });
    }
  }
  return rows;
}

const events = syntheticEvents();
const artifact = buildDynamicGoalStrengthArtifact(events);

assert.equal(artifact.version, DYNAMIC_GOAL_STRENGTH_MODEL_VERSION);
assert.equal(artifact.shadowOnly, true);
assert.equal(artifact.productionEligible, false);
assert.equal(verifyDynamicGoalStrengthArtifact(artifact), true);
assert.equal(verifyHistoricalAsOfFeatureArtifact(artifact.featureArtifact), true);
assert.match(artifact.artifactHash, HASH_PATTERN);
assert.match(artifact.model.modelHash, HASH_PATTERN);
assert.match(artifact.model.configHash, HASH_PATTERN);
assert.match(artifact.featureArtifact.artifactHash, HASH_PATTERN);
assert.match(artifact.featureArtifact.watermark.consumedRootHash, HASH_PATTERN);
assert.equal(artifact.featureArtifact.finalState.appliedRows, events.length);
assert.equal(artifact.featureArtifact.watermark.consumedRows, events.length);

const reversedArtifact = buildDynamicGoalStrengthArtifact([...events].reverse());
assert.deepEqual(reversedArtifact, artifact, "input order must not affect snapshots, state, or hashes");

const modelSource = fs.readFileSync(path.join(__dirname, "dynamicGoalStrengthModel.cjs"), "utf8");
assert.doesNotMatch(modelSource, /Math\.random|seeded\s*\(/, "the shadow strength model must not contain pseudo-random fallbacks");

const firstDate = events[0].date;
const firstDateSnapshots = artifact.featureArtifact.snapshots.filter((row) => row.forecastDate === firstDate);
assert.equal(firstDateSnapshots.length, 3);
assert.ok(firstDateSnapshots.every((row) => row.stateWatermark.consumedRows === 0));
assert.ok(firstDateSnapshots.every((row) => row.features.home.coldStart && row.features.away.coldStart));
assert.ok(firstDateSnapshots.every((row) => row.features.home.reliability === 0 && row.features.away.reliability === 0));
assert.ok(firstDateSnapshots.every((row) => row.features.home.elo === 1500 && row.features.away.elo === 1500));
assert.ok(firstDateSnapshots.every((row) => row.label === undefined && row.match.score === undefined));

for (const date of new Set(artifact.featureArtifact.snapshots.map((row) => row.forecastDate))) {
  const sameDate = artifact.featureArtifact.snapshots.filter((row) => row.forecastDate === date);
  const watermarks = new Set(sameDate.map((row) => stableHash(row.stateWatermark)));
  assert.equal(watermarks.size, 1, `all ${date} matches must be captured before one shared date-batch update`);
  for (const snapshot of sameDate) {
    assert.equal(snapshot.stateWatermark.strictBeforeForecast, true);
    if (snapshot.stateWatermark.maxConsumedAvailableAt) {
      assert.ok(Date.parse(snapshot.stateWatermark.maxConsumedAvailableAt) < Date.parse(snapshot.forecastBoundary));
    }
    if (snapshot.stateWatermark.maxConsumedMatchDate) {
      assert.ok(snapshot.stateWatermark.maxConsumedMatchDate < snapshot.forecastDate);
    }
  }
}

const sameDayMutation = clone(events);
sameDayMutation[0].historicalOutcome.homeGoals += 5;
const sameDayArtifact = buildDynamicGoalStrengthArtifact(sameDayMutation);
assert.deepEqual(
  sameDayArtifact.featureArtifact.snapshots.filter((row) => row.forecastDate === firstDate),
  firstDateSnapshots,
  "changing one result must not alter any feature captured on the same date",
);
assert.notEqual(sameDayArtifact.artifactHash, artifact.artifactHash);

const futureMutation = clone(events);
futureMutation[futureMutation.length - 1].historicalOutcome.awayGoals += 4;
const futureArtifact = buildDynamicGoalStrengthArtifact(futureMutation);
assert.deepEqual(
  futureArtifact.featureArtifact.snapshots,
  artifact.featureArtifact.snapshots,
  "the last event label must not affect any earlier feature snapshot",
);
assert.notDeepEqual(futureArtifact.featureArtifact.finalState, artifact.featureArtifact.finalState);
assert.notEqual(futureArtifact.artifactHash, artifact.artifactHash);

const middleIndex = Math.floor(events.length / 2);
const middleMutation = clone(events);
middleMutation[middleIndex].historicalOutcome.homeGoals += 4;
const middleArtifact = buildDynamicGoalStrengthArtifact(middleMutation);
const middleAvailableMs = Date.parse(events[middleIndex].availableAt);
const beforeMiddleAvailability = (candidate) => candidate.featureArtifact.snapshots.filter((row) => (
  Date.parse(row.forecastBoundary) <= middleAvailableMs
));
assert.deepEqual(
  beforeMiddleAvailability(middleArtifact),
  beforeMiddleAvailability(artifact),
  "a changed label must not alter snapshots at or before its availability boundary",
);
assert.ok(
  middleArtifact.featureArtifact.snapshots.some((row, index) => (
    Date.parse(row.forecastBoundary) > middleAvailableMs
      && row.featureHash !== artifact.featureArtifact.snapshots[index].featureHash
  )),
  "the changed label may enter state only after its strict availability boundary",
);

const matureSnapshot = [...artifact.featureArtifact.snapshots]
  .reverse()
  .find((row) => row.features.home.priorMatches >= 12 && row.features.away.priorMatches >= 12);
assert.ok(matureSnapshot, "the replay must eventually leave cold start for repeatedly observed teams");
assert.equal(matureSnapshot.features.home.coldStart, false);
assert.equal(matureSnapshot.features.away.coldStart, false);
assert.ok(matureSnapshot.features.home.reliability > 0.4);
assert.ok(matureSnapshot.features.away.reliability > 0.4);

for (const snapshot of artifact.featureArtifact.snapshots) {
  assert.match(snapshot.featureHash, HASH_PATTERN);
  for (const key of ["elo", "poisson", "final"]) {
    const audit = probabilityAudit(snapshot.probabilities[key]);
    assert.equal(audit.valid, true, `${snapshot.sourceEventId} ${key} must be normalized`);
    assert.ok(audit.minimum >= 0 && audit.maximum <= 1);
  }
}

const independentMatrix = dixonColesScoreMatrix(1.35, 1.08, { rho: 0, maxGoals: 10 });
const correctedMatrix = dixonColesScoreMatrix(1.35, 1.08, { rho: -0.08, maxGoals: 10 });
assert.ok(Math.abs(independentMatrix.reduce((sum, row) => sum + row.probability, 0) - 1) < 1e-10);
assert.ok(Math.abs(correctedMatrix.reduce((sum, row) => sum + row.probability, 0) - 1) < 1e-10);
assert.notEqual(
  correctedMatrix.find((row) => row.home === 0 && row.away === 0).probability,
  independentMatrix.find((row) => row.home === 0 && row.away === 0).probability,
  "Dixon-Coles rho must adjust low-score mass",
);
assert.equal(probabilityAudit(outcomeProbabilitiesFromMatrix(correctedMatrix)).valid, true);

const tamperedArtifact = clone(artifact);
tamperedArtifact.featureArtifact.snapshots[20].probabilities.final["1"] += 0.01;
assert.equal(verifyDynamicGoalStrengthArtifact(tamperedArtifact), false, "probability tampering must break the artifact commitment");

const watermarkTamper = clone(artifact.featureArtifact);
const watermarkDate = watermarkTamper.snapshots.find((row) => row.stateWatermark.maxConsumedAvailableAt)?.forecastDate;
for (const snapshot of watermarkTamper.snapshots.filter((row) => row.forecastDate === watermarkDate)) {
  snapshot.stateWatermark.maxConsumedAvailableAt = snapshot.forecastBoundary;
  snapshot.stateWatermark.strictBeforeForecast = true;
  snapshot.featureHash = stableHash(without(snapshot, "featureHash"));
}
watermarkTamper.watermark.featureRootHash = stableHash(
  watermarkTamper.snapshots.map((row) => `${row.sourceEventId}:${row.featureHash}`),
);
watermarkTamper.artifactHash = stableHash(without(watermarkTamper, "artifactHash"));
assert.equal(
  verifyHistoricalAsOfFeatureArtifact(watermarkTamper),
  false,
  "even re-sealed evidence must reject a watermark at or after the forecast boundary",
);

const walkForwardOptions = {
  minimumTrainingRows: 18,
  holdoutRows: 12,
  minimumFolds: 4,
};
const walkForward = evaluateDynamicGoalStrengthWalkForward(events, walkForwardOptions);
assert.equal(walkForward.version, DYNAMIC_GOAL_STRENGTH_WALK_FORWARD_VERSION);
assert.equal(walkForward.status, "evaluated-shadow");
assert.equal(walkForward.shadowOnly, true);
assert.equal(walkForward.productionEligible, false);
assert.ok(walkForward.folds.length >= 4);
assert.equal(verifyDynamicGoalStrengthWalkForward(walkForward), true);
assert.match(walkForward.manifestHash, HASH_PATTERN);
assert.equal(walkForward.probabilityAudit.invalidRows, 0);
assert.ok(walkForward.aggregate.final.rows >= 48);

for (let index = 0; index < walkForward.folds.length; index += 1) {
  const fold = walkForward.folds[index];
  assert.equal(fold.training.strictWatermark, true);
  assert.ok(fold.training.rows >= walkForwardOptions.minimumTrainingRows);
  assert.ok(fold.window.rows >= walkForwardOptions.holdoutRows);
  assert.ok(Date.parse(fold.training.trainedThrough) < Date.parse(`${fold.window.startDate}T00:00:00.000Z`));
  assert.match(fold.training.stateRootHash, HASH_PATTERN);
  assert.match(fold.holdoutDataHash, HASH_PATTERN);
  assert.match(fold.foldManifestHash, HASH_PATTERN);
  if (index > 0) {
    assert.ok(fold.window.startDate > walkForward.folds[index - 1].window.endDate);
    assert.ok(fold.training.rows >= walkForward.folds[index - 1].training.rows);
  }
}

const reversedWalkForward = evaluateDynamicGoalStrengthWalkForward([...events].reverse(), walkForwardOptions);
assert.deepEqual(reversedWalkForward, walkForward, "walk-forward evidence must be input-order invariant");

const futureWalkForward = evaluateDynamicGoalStrengthWalkForward(futureMutation, walkForwardOptions);
assert.deepEqual(
  futureWalkForward.folds[0],
  walkForward.folds[0],
  "a label beyond the first holdout must not alter the first walk-forward fold",
);
assert.notEqual(futureWalkForward.manifestHash, walkForward.manifestHash);

const tamperedWalkForward = clone(walkForward);
tamperedWalkForward.aggregate.final.brier += 0.01;
assert.equal(verifyDynamicGoalStrengthWalkForward(tamperedWalkForward), false);

const watermarkWalkForward = clone(walkForward);
watermarkWalkForward.folds[0].training.trainedThrough = `${watermarkWalkForward.folds[0].window.startDate}T00:00:00.000Z`;
watermarkWalkForward.folds[0].foldManifestHash = stableHash(without(watermarkWalkForward.folds[0], "foldManifestHash"));
watermarkWalkForward.manifestHash = stableHash(without(watermarkWalkForward, "manifestHash"));
assert.equal(
  verifyDynamicGoalStrengthWalkForward(watermarkWalkForward),
  false,
  "a re-sealed non-strict training watermark must fail closed",
);

const insufficient = evaluateDynamicGoalStrengthWalkForward(events.slice(0, 15), walkForwardOptions);
assert.equal(insufficient.status, "blocked-shadow");
assert.ok(insufficient.blockers.some((blocker) => blocker.startsWith("walk-forward-folds:")));
assert.equal(verifyDynamicGoalStrengthWalkForward(insufficient), true);

assert.throws(
  () => buildHistoricalAsOfFeatureArtifact([events[0], clone(events[0])], {
    version: "duplicate-check",
    createState: () => ({}),
    captureFeature: () => ({}),
    applyResultBatch: () => {},
    serializeState: () => ({}),
  }),
  (error) => error?.code === "DUPLICATE_EVENT_ID",
);

console.log(JSON.stringify({
  ok: true,
  verifier: "historical-strength-model",
  checks: 33,
  sample: {
    events: events.length,
    dateBatches: artifact.featureArtifact.input.dateBatches,
    teams: Object.keys(artifact.featureArtifact.finalState.teams).length,
    folds: walkForward.folds.length,
    evaluatedRows: walkForward.aggregate.final.rows,
  },
  hashes: {
    artifact: artifact.artifactHash,
    featureArtifact: artifact.featureArtifact.artifactHash,
    model: artifact.model.modelHash,
    walkForward: walkForward.manifestHash,
  },
  policies: [
    "input-order-invariant",
    "same-date-predict-before-update",
    "available-at-strictly-before-forecast",
    "future-label-isolated",
    "dynamic-elo-and-hierarchical-attack-defense",
    "dixon-coles-low-score-correction",
    "cold-start-shrinkage",
    "content-addressed-artifact-and-watermark",
    "multi-fold-date-batch-walk-forward",
    "shadow-only-no-production-wiring",
  ],
}, null, 2));
