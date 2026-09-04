const assert = require("assert");
const {
  buildHadHandicapRelationships,
  hadHandicapRelationshipFromScoreRows,
} = require("./syncData.cjs");

const approx = (actual, expected, tolerance = 1e-6, message = "") => {
  assert.ok(
    Number.isFinite(Number(actual)) && Math.abs(Number(actual) - Number(expected)) <= tolerance,
    `${message || "value mismatch"}: expected ${expected}, received ${actual}`
  );
};

const sumTriplet = (triplet) => Number(triplet.home || 0) + Number(triplet.draw || 0) + Number(triplet.away || 0);
const exactScore = (home, away) => [{ home, away, probability: 1 }];
const hhadMarket = { home: 0.2, draw: 0.55, away: 0.25 };

const homeWinMinusOne = hadHandicapRelationshipFromScoreRows(exactScore(2, 1), -1, "1", hhadMarket);
assert.ok(homeWinMinusOne, "2:1 / -1 relationship should resolve");
approx(homeWinMinusOne.hadDirectionProbability, 1, 1e-9, "2:1 remains a HAD home win");
approx(homeWinMinusOne.hhadProbabilities.draw, 1, 1e-9, "2:1 at -1 is HHAD draw");
approx(homeWinMinusOne.conditionalCoverProbability, 0, 1e-9, "2:1 at -1 does not cover");
approx(homeWinMinusOne.conditionalHandicapDrawProbability, 1, 1e-9, "2:1 at -1 lands on handicap draw");
approx(homeWinMinusOne.conditionalWinNotCoverProbability, 0, 1e-9, "2:1 at -1 is not a handicap loss");
approx(homeWinMinusOne.conditionalCompatibleSupport, 0.55, 1e-9, "-1 support follows the compatible HHAD draw, not HHAD home code");
assert.deepStrictEqual(homeWinMinusOne.compatibleHhadCodes, ["X"]);

const homeWinMinusTwo = hadHandicapRelationshipFromScoreRows(exactScore(2, 1), -2, "1", {
  home: 0.6,
  draw: 0.2,
  away: 0.2,
});
assert.ok(homeWinMinusTwo, "2:1 / -2 relationship should resolve");
approx(homeWinMinusTwo.hadDirectionProbability, 1, 1e-9, "2:1 remains a HAD home win at -2");
approx(homeWinMinusTwo.hhadProbabilities.away, 1, 1e-9, "2:1 at -2 is HHAD away");
approx(homeWinMinusTwo.conditionalWinNotCoverProbability, 1, 1e-9, "2:1 at -2 is win without cover");
approx(homeWinMinusTwo.scoreConditionalNonLossSupport, 0, 1e-9, "-2 score distribution rejects false same-code support");
approx(homeWinMinusTwo.conditionalCompatibleSupport, 0, 1e-9, "strong HHAD-home market price cannot override an incompatible -2 margin");
assert.deepStrictEqual(homeWinMinusTwo.compatibleHhadCodes, ["2"]);

const homeWinLevel = hadHandicapRelationshipFromScoreRows(exactScore(2, 1), 0, "1", hhadMarket);
approx(homeWinLevel.hhadProbabilities.home, 1, 1e-9, "2:1 at level ball is HHAD home");
approx(homeWinLevel.conditionalCoverProbability, 1, 1e-9, "2:1 at level ball covers");
approx(homeWinLevel.conditionalCompatibleSupport, 0.2, 1e-9, "level-ball support uses the only compatible HHAD home outcome");

const awayWinPlusOne = hadHandicapRelationshipFromScoreRows(exactScore(0, 1), 1, "2", hhadMarket);
approx(awayWinPlusOne.hhadProbabilities.draw, 1, 1e-9, "0:1 at home +1 is HHAD draw");
approx(awayWinPlusOne.conditionalHandicapDrawProbability, 1, 1e-9, "away one-goal win lands on handicap draw at +1");

const awayWinPlusTwo = hadHandicapRelationshipFromScoreRows(exactScore(0, 1), 2, "2", hhadMarket);
approx(awayWinPlusTwo.hhadProbabilities.home, 1, 1e-9, "0:1 at home +2 is HHAD home");
approx(awayWinPlusTwo.conditionalWinNotCoverProbability, 1, 1e-9, "away wins but does not cover when giving two through home +2");
approx(awayWinPlusTwo.conditionalCompatibleSupport, 0, 1e-9, "away code is not treated as automatic HHAD-away support");

const hadDrawMinusOne = hadHandicapRelationshipFromScoreRows(exactScore(1, 1), -1, "X", hhadMarket);
approx(hadDrawMinusOne.hadDirectionProbability, 1, 1e-9, "1:1 is HAD draw");
approx(hadDrawMinusOne.hhadProbabilities.away, 1, 1e-9, "1:1 at -1 maps to HHAD away");
approx(hadDrawMinusOne.conditionalCompatibleSupport, 0.25, 1e-9, "HAD draw uses its line-specific compatible HHAD outcome");
assert.deepStrictEqual(hadDrawMinusOne.compatibleHhadCodes, ["2"]);

const halfBall = hadHandicapRelationshipFromScoreRows(exactScore(2, 1), -1.5, "1", hhadMarket);
approx(halfBall.hhadProbabilities.away, 1, 1e-9, "2:1 at -1.5 is HHAD away");
approx(halfBall.handicapDrawProbability, 0, 1e-9, "half-ball line cannot produce HHAD draw from integer scores");

const poissonMinusOne = buildHadHandicapRelationships(1.7, 1.05, -1, {
  home: 0.34,
  draw: 0.31,
  away: 0.35,
});
approx(
  ["1", "X", "2"].reduce((sum, code) => sum + Number(poissonMinusOne[code].hadDirectionProbability || 0), 0),
  1,
  2e-6,
  "full Poisson HAD distribution should normalize"
);
for (const code of ["1", "X", "2"]) {
  const relationship = poissonMinusOne[code];
  approx(sumTriplet(relationship.hhadProbabilities), 1, 2e-6, `${code} HHAD distribution should normalize`);
  approx(sumTriplet(relationship.conditionalHhadGivenHad), 1, 2e-6, `${code} conditional HHAD distribution should normalize`);
  assert.ok(
    relationship.conditionalCompatibleSupport >= 0 && relationship.conditionalCompatibleSupport <= 1,
    `${code} conditional support should be bounded`
  );
}
approx(
  poissonMinusOne["1"].conditionalWinNotCoverProbability,
  0,
  1e-9,
  "a HAD home win cannot become HHAD away at exactly -1"
);

const poissonMinusTwo = buildHadHandicapRelationships(1.7, 1.05, -2, {
  home: 0.34,
  draw: 0.31,
  away: 0.35,
});
assert.ok(
  poissonMinusTwo["1"].conditionalWinNotCoverProbability > 0,
  "a HAD home win can become HHAD away at -2"
);
assert.ok(
  poissonMinusTwo["1"].conditionalCompatibleSupport < poissonMinusOne["1"].conditionalCompatibleSupport,
  "deeper handicap should reduce conditional non-loss support for the same score model"
);

assert.strictEqual(
  hadHandicapRelationshipFromScoreRows(exactScore(2, 1), "not-a-line", "1", hhadMarket),
  null,
  "invalid handicap lines must fail closed"
);
assert.deepStrictEqual(
  buildHadHandicapRelationships(1.5, 1.1, "", hhadMarket),
  { "1": null, X: null, "2": null },
  "missing handicap lines must not become level ball"
);

console.log("HAD/HHAD margin relationship verification passed (20 checks).");
