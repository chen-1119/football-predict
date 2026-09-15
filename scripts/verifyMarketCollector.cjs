"use strict";

const assert = require("node:assert/strict");
const {
  adaptivePollSeconds,
  jitteredDelayMs,
  marketsFromParsedRows,
} = require("./runMarketCollector.cjs");

const observedAt = "2026-09-14T12:00:00.000Z";
const parsedRows = [{
  signal: {
    sourceMatchId: "123456",
    fixtureId: "654321",
    matchNo: "周一001",
    leagueName: "测试联赛",
    homeTeamName: "主队",
    awayTeamName: "客队",
    kickoffTime: "2026-09-14T13:00:00+00:00",
    buyEndTime: "20:55",
    handicapLine: "-1",
    bookmakerOdds: {
      had: { odds1: 1.82, oddsX: 3.45, odds2: 4.20 },
      hhad: { odds1: 3.10, oddsX: 3.55, odds2: 1.95 },
    },
  },
}];

const markets = marketsFromParsedRows(parsedRows, observedAt);
assert.equal(markets.length, 2);
assert.equal(markets[0].sourceMatchId, "123456");
assert.equal(markets[0].bookmaker, "sporttery");
assert.equal(markets.find((row) => row.pool === "hhad").handicapLine, -1);
assert.match(markets[0].contentHash, /^[0-9a-f]{64}$/);

const laterMarkets = marketsFromParsedRows(parsedRows, "2026-09-14T12:01:00.000Z");
assert.equal(laterMarkets[0].contentHash, markets[0].contentHash, "receipt time must not change market state hash");

const changedRows = structuredClone(parsedRows);
changedRows[0].signal.bookmakerOdds.had.odds1 = 1.80;
const changed = marketsFromParsedRows(changedRows, observedAt);
assert.notEqual(changed.find((row) => row.pool === "had").contentHash, markets.find((row) => row.pool === "had").contentHash);
assert.equal(changed.find((row) => row.pool === "hhad").contentHash, markets.find((row) => row.pool === "hhad").contentHash);

const at = Date.parse("2026-09-14T12:00:00.000Z");
const marketAt = (minutes) => [{ kickoffTime: new Date(at + minutes * 60_000).toISOString() }];
assert.equal(adaptivePollSeconds(marketAt(10), at), 60);
assert.equal(adaptivePollSeconds(marketAt(30), at), 120);
assert.equal(adaptivePollSeconds(marketAt(90), at), 300);
assert.equal(adaptivePollSeconds(marketAt(240), at), 600);
assert.equal(adaptivePollSeconds(marketAt(720), at), 900);
assert.equal(adaptivePollSeconds(marketAt(1800), at), 1800);
assert.equal(adaptivePollSeconds([], at), 900);

assert.equal(jitteredDelayMs(120, () => 0), 102_000);
assert.equal(jitteredDelayMs(120, () => 0.5), 120_000);
assert.equal(jitteredDelayMs(120, () => 1), 138_000);
assert.equal(jitteredDelayMs(60, () => 0), 60_000, "minimum interval must remain at least 60 seconds");

console.log(JSON.stringify({
  ok: true,
  tests: {
    markets: markets.length,
    stableHash: true,
    changeDetection: true,
    adaptiveSchedule: true,
    jitterBounds: true,
  },
}, null, 2));
