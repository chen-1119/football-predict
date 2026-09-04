"use strict";

const assert = require("node:assert/strict");
const {
  ODDS_OBSERVATION_TRAIL_VERSION,
  compactOddsObservations,
  oddsObservationTrailForRow,
  withOddsObservationTrail,
} = require("../src/services/oddsObservationTrail.cjs");

const fixture = (overrides = {}) => ({
  sourceMatchId: "2041001",
  poolCode: "HAD",
  cutoffTime: "2026-07-28T11:55:00.000Z",
  kickoffTime: "2026-07-28T12:00:00.000Z",
  oddsSource: "sporttery:HAD",
  oddsSourceMethod: "current",
  oddsSourceUrl: "https://webapi.sporttery.cn/gateway/uniform/football/getMatchListV1.qry",
  oddsReceivedAt: "2026-07-28T10:00:00.000Z",
  sourceCycleId: "cycle-1",
  ...overrides,
});

const first = withOddsObservationTrail(fixture());
assert.equal(first.observationTrailVersion, ODDS_OBSERVATION_TRAIL_VERSION);
assert.equal(first.observationCount, 1);
assert.equal(first.firstObservationAt, "2026-07-28T10:00:00.000Z");

const replayed = withOddsObservationTrail(first, fixture());
assert.equal(replayed.observationCount, 1, "a preserved response clock cannot fabricate a second observation");

const laterSameOdds = withOddsObservationTrail(first, fixture({
  oddsReceivedAt: "2026-07-28T11:45:00.000Z",
  sourceCycleId: "cycle-2",
}));
assert.equal(laterSameOdds.observationCount, 2);
assert.equal(laterSameOdds.lastObservationAt, "2026-07-28T11:45:00.000Z");

const afterCutoff = withOddsObservationTrail(laterSameOdds, fixture({
  oddsReceivedAt: "2026-07-28T11:56:00.000Z",
  sourceCycleId: "cycle-3",
}));
assert.equal(afterCutoff.observationCount, 2, "post-cutoff observations must fail closed");

const unofficial = withOddsObservationTrail(fixture({
  oddsSource: "500.com:HAD",
  oddsSourceUrl: "https://trade.500.com/jczq",
}));
assert.equal(unofficial.observationCount, 0);

const futureProviderClock = withOddsObservationTrail(fixture({
  oddsObservedAt: "2026-07-28T10:01:00.000Z",
}));
assert.equal(futureProviderClock.observationCount, 0);

const many = Array.from({ length: 20 }, (_, index) => ({
  version: "official-odds-observation-v1",
  availableAt: new Date(Date.parse("2026-07-28T08:00:00.000Z") + index * 60_000).toISOString(),
  receivedAt: new Date(Date.parse("2026-07-28T08:00:00.000Z") + index * 60_000).toISOString(),
}));
const compacted = compactOddsObservations(many, 5);
assert.equal(compacted.length, 5);
assert.equal(compacted[0].availableAt, many[0].availableAt);
assert.equal(compacted.at(-1).availableAt, many.at(-1).availableAt);

const legacyTrail = oddsObservationTrailForRow({
  ...fixture({ oddsReceivedAt: null }),
  observationTrail: laterSameOdds.observationTrail,
});
assert.equal(legacyTrail.length, 2);

process.stdout.write(`${JSON.stringify({
  ok: true,
  verifier: "odds-observation-trail",
  version: ODDS_OBSERVATION_TRAIL_VERSION,
  assertions: 13,
  sample: laterSameOdds,
}, null, 2)}\n`);
