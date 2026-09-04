"use strict";

const assert = require("node:assert/strict");
const {
  HASH_PATTERN,
  stableHash,
} = require("./historicalAsOfFeatureBuilder.cjs");
const {
  buildHistoricalMarketResearch,
  candidateGrid,
  canonicalMarketOdds,
  devigOdds,
  verifyHistoricalMarketResearch,
} = require("./historicalMarketResearch.cjs");

const isoDate = (day) => new Date(Date.UTC(2018, 0, 1 + day)).toISOString().slice(0, 10);
const round = (value) => Number(value.toFixed(4));

const softmax3 = (homeStrength, drawStrength, awayStrength) => {
  const raw = [Math.exp(homeStrength), Math.exp(drawStrength), Math.exp(awayStrength)];
  const total = raw.reduce((sum, value) => sum + value, 0);
  return raw.map((value) => value / total);
};

const events = Array.from({ length: 720 }, (_, index) => {
  const day = Math.floor(index / 3);
  const homeIndex = index % 24;
  const awayIndex = (index * 7 + 5) % 24 === homeIndex
    ? (homeIndex + 1) % 24
    : (index * 7 + 5) % 24;
  const homePower = Math.sin((homeIndex + 1) * 0.53) + 0.22;
  const awayPower = Math.sin((awayIndex + 1) * 0.53);
  const [homeProbability, drawProbability, awayProbability] = softmax3(
    homePower - awayPower,
    -0.1 + Math.cos(index * 0.17) * 0.08,
    awayPower - homePower,
  );
  const selector = ((index * 7919) % 1000) / 1000;
  const outcome = selector < homeProbability
    ? "1"
    : selector < homeProbability + drawProbability ? "X" : "2";
  const homeGoals = outcome === "1" ? 2 + (index % 2) : outcome === "X" ? 1 : index % 2;
  const awayGoals = outcome === "2" ? 2 + ((index + 1) % 2) : outcome === "X" ? 1 : (index + 1) % 2;
  const vig = 1.06;
  const date = isoDate(day);
  const availableAt = new Date(`${date}T00:00:00.000Z`);
  availableAt.setUTCDate(availableAt.getUTCDate() + 2);
  return {
    schemaVersion: "historical-training-asof-v1",
    sourceEventId: stableHash({ index, date, homeIndex, awayIndex }),
    sourceDataset: "synthetic-research-verifier",
    competition: index % 2 ? "SYN-A" : "SYN-B",
    date,
    availableAt: availableAt.toISOString(),
    availabilityProvenance: {
      source: "derived-date-plus-two-days",
      policyVersion: "derived-result-availability-v1",
      explicitObservation: false,
      strictPromotionEligible: false,
    },
    homeTeam: { raw: `Home ${homeIndex}`, normalized: `team ${homeIndex}` },
    awayTeam: { raw: `Away ${awayIndex}`, normalized: `team ${awayIndex}` },
    historicalOutcome: { homeGoals, awayGoals },
    neutral: false,
    preMatchOdds: {
      home: round(vig / homeProbability),
      draw: round(vig / drawProbability),
      away: round(vig / awayProbability),
    },
  };
});

const options = {
  minimumTrainingRows: 150,
  holdoutRows: 75,
  minimumFolds: 4,
  minimumModelTrainingRows: 20,
  minimumLeagueRows: 50,
};

const artifact = buildHistoricalMarketResearch(events, options);
assert.equal(artifact.version, "historical-market-research-shadow-v2");
assert.equal(artifact.status, "evaluated-research-shadow");
assert.equal(artifact.researchOnly, true);
assert.equal(artifact.shadowOnly, true);
assert.equal(artifact.productionEligible, false);
assert.equal(artifact.strictPromotionEligible, false);
assert.equal(verifyHistoricalMarketResearch(artifact), true);
assert.match(artifact.manifestHash, HASH_PATTERN);
assert.ok(artifact.walkForward.folds.length >= 4);
assert.ok(artifact.source.evaluatedRows > 400);
assert.equal(artifact.evidenceBoundary.strictPromotionEligibleRows, 0);
assert.equal(artifact.evidenceBoundary.marketOddsObservedAtCoverage, 0);
assert.ok(artifact.evidenceBoundary.blockers.includes("result-availability-derived"));
assert.ok(artifact.walkForward.aggregate.market.rows > 0);
assert.equal(artifact.walkForward.aggregate.market.rows, artifact.walkForward.aggregate.dynamicModel.rows);
assert.equal(artifact.walkForward.aggregate.market.rows, artifact.walkForward.aggregate.selected.rows);

for (const fold of artifact.walkForward.folds) {
  assert.ok(fold.training.endDate < fold.window.startDate);
  assert.ok(fold.selection.fit.endDate < fold.selection.validation.startDate);
  assert.ok(fold.selection.validation.endDate <= fold.training.endDate);
  assert.ok(fold.selection.selectedModelCandidate.modelWeight > 0);
  assert.ok(fold.window.rows >= options.holdoutRows);
  assert.match(fold.foldManifestHash, HASH_PATTERN);
  assert.ok(Number.isFinite(fold.metrics.market.brier));
  assert.ok(Number.isFinite(fold.metrics.dynamicModel.logLoss));
  if (fold.selection.selectedCandidate.outcomeBiasStrength > 0) {
    assert.equal(
      fold.selection.selectedCandidate.outcomeBias.version,
      "market-outcome-intercept-calibration-v1",
    );
    assert.equal(
      fold.selection.selectedCandidate.outcomeBias.fitRows,
      fold.training.rows,
    );
    assert.match(fold.selection.selectedCandidate.outcomeBias.fitHash, HASH_PATTERN);
  }
}

const reversed = buildHistoricalMarketResearch([...events].reverse(), options);
assert.deepEqual(reversed, artifact, "research artifact must be input-order invariant");

const futureMutation = events.map((event, index) => (
  index === events.length - 1
    ? {
        ...event,
        historicalOutcome: { homeGoals: 7, awayGoals: 0 },
        preMatchOdds: { home: 8.5, draw: 5.2, away: 1.25 },
      }
    : event
));
const futureArtifact = buildHistoricalMarketResearch(futureMutation, options);
assert.deepEqual(
  futureArtifact.walkForward.folds[0],
  artifact.walkForward.folds[0],
  "a future-row mutation must not change the first completed research fold",
);
assert.notEqual(futureArtifact.manifestHash, artifact.manifestHash);

const tampered = structuredClone(artifact);
tampered.walkForward.aggregate.market.brier += 0.01;
assert.equal(verifyHistoricalMarketResearch(tampered), false);

const noOdds = { ...events[0], preMatchOdds: { home: 2 } };
assert.equal(canonicalMarketOdds(noOdds), null);
const noVig = devigOdds({ "1": 2, X: 4, "2": 4 });
assert.ok(Math.abs(noVig["1"] + noVig.X + noVig["2"] - 1) < 1e-8);

const grid = candidateGrid({ modelWeights: [0], temperatures: [1] });
assert.ok(grid.some((candidate) => candidate.modelWeight === 0 && candidate.temperature === 1));
assert.ok(grid.some((candidate) => candidate.modelWeight > 0));
assert.ok(grid.some((candidate) => candidate.outcomeBiasStrength > 0));
assert.ok(candidateGrid().some((candidate) => candidate.modelWeight < 0));

console.log(JSON.stringify({
  ok: true,
  verifier: "historical-market-research-v2",
  assertions: 41,
  inputRows: events.length,
  evaluatedRows: artifact.source.evaluatedRows,
  folds: artifact.walkForward.folds.length,
  aggregate: artifact.walkForward.aggregate,
  manifestHash: artifact.manifestHash,
}, null, 2));
