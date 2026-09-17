"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { independentCandidate, candidatesFor, choose, canPublish, probabilities, productFor } = require("./independentComboSelection.cjs");
const { buildLedger, persistLedger } = require("./dailyFeaturedComboLedger.cjs");
const now = Date.parse("2026-09-16T10:00:00Z");
const publication = { generationId: "test-generation", manifestHash: "test-manifest" };
const iso = (ms) => new Date(ms).toISOString();
function match(id, overrides = {}, clock = now) {
  return { id: `sporttery_${id}`, sourceMatchId: String(id), businessDate: "2026-09-16",
    status: "SCHEDULED", kickoffTime: "2026-09-16T15:00:00Z", eventVersion: "2026-09-16T15:00:00Z",
    buyEndTime: "2026-09-16T14:00:00Z", homeTeamId: `h-${id}`, awayTeamId: `a-${id}`,
    homeTeamName: `主队${id}`, awayTeamName: `客队${id}`, leagueId: "test-league",
    odds: { odds1: 1.8, oddsX: 3.3, odds2: 4.5 }, oddsSource: "sporttery:had", oddsUpdatedAt: iso(clock - 1000),
    probabilityModel: { generatedAt: iso(clock - 1000), oneXTwo: { final: { home: 56, draw: 25, away: 19 } } },
    predictions: [{ marketType: "BEST", recommendationAction: "reference", tipCode: "WATCH", trustScore: 0 }], ...overrides };
}
const inputs = (clock = now, more = {}) => ({ now: clock, current: [1, 2, 3].map((id) => match(id, {}, clock)), history: [], entries: [], publication, publishable: true, ...more });

test("zero formal recommendations produces two- and three-leg previews", () => {
  const result = buildLedger(inputs());
  assert.equal(result.publicPayload.candidateCount, 3);
  assert.deepEqual(result.publicPayload.previews.map((row) => row.size), [2, 3]);
  assert.equal(result.publicPayload.previews[0].totalOdds, 3.24);
  assert.equal(result.publicPayload.previews[1].totalOdds, 5.83);
  assert.equal(result.entries.length, 0);
});
test("no prediction array at all is required", () => assert.ok(independentCandidate(match(1, { predictions: [] }), now)));
test("formal label/evidence/cooling changes do not alter independent selection", () => {
  const a = match(1), b = structuredClone(a); b.predictions[0] = { recommendationAction: "recommend", trustScore: 100, marketType: "BEST", tipCode: "2" };
  assert.deepEqual(independentCandidate(a, now), independentCandidate(b, now));
});
test("model shadow and unreliable formal recommendation do not suppress healthy data", () => {
  assert.equal(canPublish({ status: { serviceOk: true, dataFresh: true, modelRiskStable: false, recommendationReliable: false } }, { updatedAt: iso(now), publication }, publication, now), true);
});
test("generation mismatch still rejects publication", () => assert.equal(canPublish({ status: { serviceOk: true, dataFresh: true } }, { updatedAt: iso(now), publication }, { ...publication, generationId: "different" }, now), false));
test("stale data still rejects publication", () => assert.equal(canPublish({ status: { serviceOk: true, dataFresh: true } }, { updatedAt: iso(now - 16 * 60000), publication }, publication, now), false));
test("direction is model argmax, not lowest SP", () => {
  const m = match(1, { probabilityModel: { generatedAt: iso(now), oneXTwo: { final: { home: 20, draw: 30, away: 50 } } } });
  const c = independentCandidate(m, now); assert.equal(c.tipCode, "2"); assert.equal(c.odds, 4.5);
});
test("single-leg SP over 2.60 is allowed", () => assert.ok(independentCandidate(match(1, { odds: { odds1: 2.8, oddsX: 3, odds2: 2.5 } }), now)));
test("full probability vector is mandatory; null and boolean cannot become zero", () => {
  for (const home of [null, undefined, true, "", -1]) assert.equal(probabilities({ home, draw: 30, away: 20 }), null);
  assert.equal(probabilities({ home: 6, draw: 3, away: 1 }), null);
});
test("fraction and percentage probabilities normalize identically", () => assert.deepEqual(probabilities({ home: 0.5, draw: 0.3, away: 0.2 }), probabilities({ home: 50, draw: 30, away: 20 })));
test("a model tie is not resolved with a made-up direction", () => assert.equal(independentCandidate(match(1, { probabilityModel: { generatedAt: iso(now), oneXTwo: { final: { home: 40, draw: 40, away: 20 } } } }), now), null));
test("future model timestamp is rejected", () => {
  const m = match(1); m.probabilityModel.generatedAt = iso(now + 1000); assert.equal(independentCandidate(m, now), null);
});
test("stale and future official quotes rejected", () => {
  for (const stamp of [now - 16 * 60000, now + 1000]) assert.equal(independentCandidate(match(1, { oddsUpdatedAt: iso(stamp) }), now), null);
});
test("European/500 odds cannot be mislabeled as Sporttery SP", () => {
  assert.equal(independentCandidate(match(1, { oddsSource: "500.com:had" }), now), null);
  assert.equal(independentCandidate(match(1, { oddsSource: "sporttery:hhad" }), now), null);
});
test("source fallback keeps complete quote and timestamp together", () => {
  const m = match(1, { odds: { odds1: null, oddsX: 3, odds2: 4 }, externalSignals: { bookmakerOdds: { had: { odds1: 1.9, oddsX: 3, odds2: 4, source: "sporttery:had", updatedAt: iso(now) } } } });
  const c = independentCandidate(m, now); assert.equal(c.odds, 1.9); assert.equal(c.quoteObservedAt, iso(now));
});
test("started, void, suspended and closed sales never enter", () => {
  for (const patch of [{ status: "LIVE" }, { resultDisposition: "VOID" }, { isOnSale: false }, { saleStatus: "SUSPENDED" }, { buyEndTime: iso(now) }]) assert.equal(independentCandidate(match(1, patch), now), null);
});
test("old business day is never reset by midnight", () => {
  const tomorrow = Date.parse("2026-09-16T16:01:00Z");
  assert.equal(independentCandidate(match(1, {}, tomorrow), tomorrow), null);
});
test("business-day 22:00 hard stop holds even for next-day kickoff", () => {
  const stopped = Date.parse("2026-09-16T14:00:00Z");
  assert.equal(independentCandidate(match(1, { buyEndTime: "2026-09-17T00:00:00Z" }, stopped), stopped), null);
});
test("source event with changed kickoff is rejected", () => assert.equal(independentCandidate(match(1, { eventVersion: "2026-09-17T15:00:00Z" }), now), null));
test("duplicate event cannot create duplicate legs", () => {
  const rows = candidatesFor([match(1), match(1), match(2)], now); assert.equal(rows.length, 2); assert.equal(choose(rows, 3), null);
});
test("ambiguous duplicate identities are quarantined from selection", () => assert.equal(candidatesFor([match(1), match(1, { homeTeamId: "different-team" })], now).length, 0));
test("shared team cannot appear twice in a combo", () => assert.equal(choose(candidatesFor([match(1), match(2, { awayTeamId: "h-1" })], now), 2), null));
test("three distinct games in one league are not silently prohibited", () => assert.ok(choose(candidatesFor([1, 2, 3].map((id) => match(id)), now), 3)));
test("threshold compares exact unrounded decimal product", () => {
  assert.equal(productFor([{ odds: 1.58 }, { odds: 1.58 }], 2.5).passes, false);
  assert.equal(productFor([{ odds: 1.25 }, { odds: 2 }], 2.5).passes, true);
  assert.equal(productFor([{ odds: 1.7 }, { odds: 1.7 }, { odds: 1.73 }], 5).passes, false);
  assert.equal(productFor([{ odds: 1.25 }, { odds: 2 }, { odds: 2 }], 5).passes, true);
});
test("highest model likelihood is preferred among floor-qualified combos", () => {
  const base = candidatesFor([1, 2, 3].map((id) => match(id)), now);
  const result = choose(base.map((row, i) => ({ ...row, odds: 1.8, modelProbability: [0.7, 0.6, 0.5][i] })), 2);
  assert.deepEqual(result.legs.map((row) => row.sourceMatchId), ["1", "2"]); assert.equal(result.jointProbability, null);
});
test("no top-18 cap can hide an otherwise feasible pair", () => {
  const candidates = Array.from({ length: 20 }, (_, i) => ({ sourceMatchId: String(i), odds: i === 19 ? 3 : 1.1, modelProbability: 0.8 - i / 100 }));
  assert.ok(choose(candidates, 2));
});
test("21:00 freeze works even when every single pick is reference", () => {
  const clock = Date.parse("2026-09-16T13:00:00Z"); const result = buildLedger(inputs(clock));
  assert.equal(result.entries.length, 2); assert.equal(result.publicPayload.previews.length, 0);
  assert.ok(result.entries.every((row) => row.statisticsTrack === "independent-combo"));
});
test("rerun cannot replace frozen directions, probabilities or SP", () => {
  const clock = Date.parse("2026-09-16T13:00:00Z"), a = buildLedger(inputs(clock));
  const b = buildLedger(inputs(clock + 60000, { current: [match(9, {}, clock + 60000)], entries: a.entries }));
  assert.deepEqual(b.entries, a.entries);
});
test("legacy combo statistics remain separate from new independent track", () => {
  const old = { id: "legacy", businessDate: "2026-09-15", size: 2, legs: [], settlement: { status: "WON" } };
  const result = buildLedger(inputs(now, { entries: [old] }));
  assert.equal(result.publicPayload.statistics.two.won, 1); assert.equal(result.publicPayload.independentStatistics.two.won, 0);
});
test("no mutable prediction or input object is changed", () => {
  const data = inputs(); const prior = structuredClone(data); buildLedger(data); assert.deepEqual(data, prior);
});
test("the real persistence function writes preview state without inserting pre-freeze results", async () => {
  const calls = []; const client = { query: async (sql, args) => { calls.push([sql, args]); return { rows: [] }; } };
  const state = await persistLedger(client, inputs());
  assert.equal(state.previews.length, 2); assert.equal(calls.filter(([sql]) => /INSERT INTO football.daily_featured_combos\(/.test(sql)).length, 0);
  assert.equal(calls.filter(([sql]) => /daily_featured_combo_state/.test(sql)).length, 1);
});
test("the real persistence function writes frozen snapshot and settlement separately", async () => {
  const calls = []; const client = { query: async (sql, args) => { calls.push([sql, args]); return { rows: [] }; } };
  await persistLedger(client, inputs(Date.parse("2026-09-16T13:00:00Z")));
  const inserts = calls.filter(([sql]) => /INSERT INTO football.daily_featured_combos\(/.test(sql));
  assert.equal(inserts.length, 2);
  const payload = JSON.parse(inserts[0][1][3]); assert.equal(payload.statisticsTrack, "independent-combo"); assert.equal(payload.settlement, undefined);
  assert.equal(JSON.parse(inserts[0][1][4]).status, "PENDING");
});
