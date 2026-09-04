"use strict";

const assert = require("node:assert/strict");
const {
  eventSafeExistingSignal,
  externalSignalMatchesEvent,
  stampSignalEvent,
} = require("./externalSignalEventIdentity.cjs");
const { mergeMarketSignal } = require("./sync500Data.cjs");
const { mergeSignal: merge500DetailSignal } = require("./sync500Details.cjs");

const stale = {
  sourceMatchId: "2041049",
  kickoffTime: "2026-08-20T19:00:00+08:00",
  homeTeamName: "江原FC",
  awayTeamName: "大阪钢巴",
  preMatch: { sourceMatchId: "2040811", kickoffTime: "2026-08-20T19:00:00+08:00" },
  externalOdds: { odds1: 1.9, oddsX: 3.2, odds2: 3.8 },
};
const current = {
  sourceMatchId: "2041049",
  kickoffTime: "2026-08-25T03:00:00+08:00",
  homeTeamName: "斯托克城",
  awayTeamName: "赫尔城",
  bookmakerOdds: { had: { odds1: 2.2, oddsX: 3.1, odds2: 3.0 } },
};

assert.equal(externalSignalMatchesEvent(stale, current), false);
assert.deepEqual(eventSafeExistingSignal(stale, current), {});
const marketMerged = mergeMarketSignal(stale, current);
assert.equal(marketMerged.externalOdds, undefined, "stale odds must not survive a reused source id");
assert.equal(marketMerged.homeTeamName, current.homeTeamName);
const detailMerged = merge500DetailSignal(stale, current);
assert.equal(detailMerged.preMatch, undefined, "stale pre-match evidence must not survive a reused source id");
assert.equal(detailMerged.homeTeamName, current.homeTeamName);

const sameEventUpdate = {
  sourceMatchId: "2041049",
  kickoffTime: "2026-08-25T03:20:00+08:00",
  homeTeamName: "斯托克",
  awayTeamName: "赫尔",
};
assert.equal(externalSignalMatchesEvent(current, sameEventUpdate), true);
const stamped = stampSignalEvent({ source: "test" }, {
  id: "sporttery_2041049",
  sourceMatchId: "2041049",
  matchNo: "周二004",
  kickoffTime: "2026-08-25T03:00:00+08:00",
  homeTeamName: "斯托克城",
  awayTeamName: "赫尔城",
});
assert.equal(stamped.matchNo, "周二004");
assert.equal(stamped.homeTeamName, "斯托克城");

console.log(JSON.stringify({ ok: true, checks: 9, verifier: "external-signal-event-identity-v1" }, null, 2));
