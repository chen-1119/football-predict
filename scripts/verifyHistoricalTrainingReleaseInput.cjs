"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const {
  HISTORICAL_TRAINING_RELEASE_ENTRY,
  inspectHistoricalTrainingFile,
} = require("./historicalTrainingReleaseArtifact.cjs");
const {
  loadHistoricalTrainingIndex,
  matchesAfterHistoricalTrainingCutoff,
  mergeFreshWithExistingStore,
  seedEloFromTraining,
} = require("./syncData.cjs");

const rootDir = path.resolve(__dirname, "..");
const sourcePath = path.join(rootDir, "server-data", "training", "historical-training-index.json");
const inspection = inspectHistoricalTrainingFile(sourcePath);
assert.equal(inspection.ok, true, `historical training release input invalid: ${(inspection.blockers || []).join(",")}`);
assert.equal(inspection.entry, HISTORICAL_TRAINING_RELEASE_ENTRY);
assert.ok(inspection.sha256);

const loaded = loadHistoricalTrainingIndex();
assert.ok(loaded, "runtime loader must find one validated historical training index");
assert.equal(loaded.version, inspection.version);
assert.equal(Number(loaded.sample?.rows), inspection.rows);

const ratings = new Map();
const counts = new Map();
const seeded = seedEloFromTraining(ratings, counts, {
  teams: {
    null_rating: { latestElo: null, matches: 900 },
    blank_rating: { latestElo: "", matches: 800 },
    zero_rating: { latestElo: 0, matches: 700 },
    low_rating: { latestElo: 799.99, matches: 600 },
    high_rating: { latestElo: 2400.01, matches: 500 },
    valid_rating: { latestElo: 1512.5, matches: 42 },
  },
});
assert.equal(seeded, 1, "only a finite in-range Elo rating may seed production state");
assert.deepEqual([...ratings.entries()], [["valid_rating", 1512.5]]);
assert.deepEqual([...counts.entries()], [["valid_rating", 42]]);

const productionRatings = new Map();
const productionCounts = new Map();
const productionSeeded = seedEloFromTraining(productionRatings, productionCounts, loaded);
assert.equal(productionSeeded, inspection.finiteEloTeams);
assert.ok([...productionRatings.values()].every((rating) => rating >= 800 && rating <= 2400));
assert.ok(![...productionRatings.values()].includes(0), "null historical Elo must never become zero");

const cutoffSelection = matchesAfterHistoricalTrainingCutoff([
  {
    sourceMatchId: "pre-cutoff-event-late-prediction",
    kickoffTime: "2026-06-08T12:00:00.000Z",
    predictionMeta: { generatedAt: "2026-07-28T00:00:00.000Z" },
  },
  {
    sourceMatchId: "post-cutoff-event",
    kickoffTime: "2026-06-09T00:00:00.000Z",
    predictionMeta: { generatedAt: "2026-06-08T00:00:00.000Z" },
  },
], loaded);
assert.deepEqual(
  cutoffSelection.map((match) => match.sourceMatchId),
  ["post-cutoff-event"],
  "incremental Elo selection must use event time and must not replay pre-cutoff results"
);

const mergedModelRevision = mergeFreshWithExistingStore([
  {
    id: "sporttery_merge_training_revision",
    sourceMatchId: "merge_training_revision",
    eventVersion: "2026-07-30T08:00:00.000Z",
    kickoffTime: "2026-07-30T08:00:00.000Z",
    status: "SCHEDULED",
    homeTeamName: "Home",
    awayTeamName: "Away",
    probabilityModel: {
      version: "model-only-unified-v61",
      generatedAt: "2026-07-28T06:00:00.000Z",
      unifiedPosterior: { version: "v61-model-only-auditable-input-gate" },
      elo: { homeRating: 0, awayRating: 20, historicalSource: { version: "historical-training-v1" } },
    },
    predictionMeta: {
      policyVersion: "old-policy",
      trainingSignature: "old-application",
      generatedAt: "2026-07-28T06:00:00.000Z",
    },
    predictions: [{ marketType: "BEST", tipCode: "1" }],
  },
], [
  {
    id: "sporttery_merge_training_revision",
    sourceMatchId: "merge_training_revision",
    eventVersion: "2026-07-30T08:00:00.000Z",
    kickoffTime: "2026-07-30T08:00:00.000Z",
    status: "SCHEDULED",
    homeTeamName: "Home",
    awayTeamName: "Away",
    probabilityModel: {
      version: "model-only-unified-v64",
      generatedAt: "2026-07-28T07:00:00.000Z",
      unifiedPosterior: {
        version: "v64-model-only-trusted-incremental-history",
        generatedAt: "2026-07-28T07:00:00.000Z",
      },
      elo: { homeRating: 1500, awayRating: 1520, historicalSource: { version: "historical-training-v1" } },
    },
    predictionMeta: {
      policyVersion: "sporttery-day-formula-trace-v65-trusted-incremental-history",
      trainingSignature: "application:historical-training-application-v3-signed-seed-trusted-event-incremental",
      generatedAt: "2026-07-28T07:00:00.000Z",
    },
    predictions: [{ marketType: "BEST", tipCode: "1" }],
  },
]);
assert.equal(mergedModelRevision[0]?.probabilityModel?.version, "model-only-unified-v64");
assert.equal(mergedModelRevision[0]?.probabilityModel?.elo?.homeRating, 1500);

console.log(JSON.stringify({
  ok: true,
  verifier: "historical-training-release-input",
  releaseEntry: inspection.entry,
  sha256: inspection.sha256,
  bytes: inspection.bytes,
  version: inspection.version,
  rows: inspection.rows,
  teams: inspection.teams,
  finiteEloTeams: inspection.finiteEloTeams,
  explicitNullRatings: inspection.explicitNullRatings,
  ratingRange: {
    min: inspection.minElo,
    max: inspection.maxElo,
  },
  seededTeams: productionSeeded,
  invariants: [
    "signed release asset passes schema and distribution checks",
    "null, blank, zero and out-of-range Elo values are rejected",
    "production seed count equals validated finite Elo coverage",
    "incremental Elo excludes pre-cutoff events even when prediction clocks are newer",
    "new training/model revisions replace richer but obsolete pre-match model payloads",
  ],
}, null, 2));
