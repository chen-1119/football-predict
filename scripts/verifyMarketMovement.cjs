const assert = require("node:assert/strict");
const {
  DEVIG_METHOD,
  analyzeMarketMovement,
  devigOdds,
  movementEvidenceForCode,
} = require("../src/services/marketMovement.cjs");

const had = analyzeMarketMovement({
  pool: "HAD",
  openOdds: { odds1: 2.2, oddsX: 3.2, odds2: 3.4 },
  currentOdds: { odds1: 1.9, oddsX: 3.5, odds2: 4 },
  sampleSize: 4,
});
assert.equal(had.available, true);
assert.equal(had.devigMethod, DEVIG_METHOD);
assert.ok(had.changes["1"].probabilityDelta > 0);
assert.ok(had.changes["2"].probabilityDelta < 0);
const homeEvidence = movementEvidenceForCode(had, "1");
const awayEvidence = movementEvidenceForCode(had, "2");
assert.equal(homeEvidence.supports, true);
assert.equal(homeEvidence.contradicts, false);
assert.equal(awayEvidence.contradicts, true);

const oddsFor = (probabilities, overround) => ({
  odds1: 1 / (probabilities[0] * overround),
  oddsX: 1 / (probabilities[1] * overround),
  odds2: 1 / (probabilities[2] * overround),
});
const marginOnly = analyzeMarketMovement({
  pool: "HAD",
  openOdds: oddsFor([0.5, 0.3, 0.2], 1.04),
  currentOdds: oddsFor([0.5, 0.3, 0.2], 1.1),
  sampleSize: 3,
});
assert.ok(Math.abs(marginOnly.changes["1"].probabilityDelta) <= 0.000001);
assert.ok(Math.abs(marginOnly.changes.X.probabilityDelta) <= 0.000001);
assert.equal(marginOnly.overroundShiftMaterial, true);
assert.equal(movementEvidenceForCode(marginOnly, "1").supports, false,
  "bookmaker margin movement alone must not become directional support");

const hhad = analyzeMarketMovement({
  pool: "HHAD",
  openLine: -1,
  currentLine: -2,
  openOdds: { odds1: 2.7, oddsX: 3.5, odds2: 2.05 },
  currentOdds: { odds1: 2.9, oddsX: 3.6, odds2: 1.9 },
  sampleSize: 5,
});
assert.equal(hhad.line.delta, -1);
assert.equal(hhad.line.direction, "home-gives-more");
const hhadCrossLineEvidence = movementEvidenceForCode(hhad, "2");
assert.equal(hhadCrossLineEvidence.lineMovement.direction, "home-gives-more");
assert.equal(hhadCrossLineEvidence.supports, false);
assert.equal(hhadCrossLineEvidence.blocker, "handicap-line-changed-requires-separate-cohort");

const missing = analyzeMarketMovement({
  openOdds: { odds1: 2, oddsX: 3 },
  currentOdds: { odds1: 1.9, oddsX: 3.2, odds2: 4 },
});
assert.equal(missing.available, false);
assert.equal(missing.blocker, "invalid-or-incomplete-odds");
assert.equal(devigOdds({ odds1: 1, oddsX: 3, odds2: 4 }), null);

console.log(JSON.stringify({
  ok: true,
  verifier: "market-movement",
  assertions: 16,
  devigMethod: DEVIG_METHOD,
  had: {
    changes: had.changes,
    overroundDelta: had.overroundDelta,
  },
  hhad: {
    line: hhad.line,
    changes: hhad.changes,
  },
  marginOnly: {
    changes: marginOnly.changes,
    overroundDelta: marginOnly.overroundDelta,
  },
}, null, 2));
