"use strict";
const assert = require("node:assert/strict"), crypto = require("node:crypto");
const { predictionSet, predictionSetWithoutOfficialOdds, replayPredictionWithClock } = require("./syncData.cjs");
const { encode } = require("./predictionExecutionCapture.cjs");
const { executeWithPredictionClock, predictionNowMs, predictionNowIso, verifyPredictionClock } = require("../src/services/predictionExecutionClock.cjs");
const fixture = () => ({ sourceMatchId: "clock-fixture", kickoffTime: "2099-09-09T03:00:00+08:00", status: "SCHEDULED",
  homeTeam: "Synthetic Home", awayTeam: "国际米兰", leagueName: "欧洲冠军联赛", oddsSource: "sporttery:HAD", oddsUpdatedAt: new Date().toISOString(),
  odds: { odds1: 2.1, oddsX: 3.4, odds2: 3.3 },
  formSnapshot: { sampleSize: 24, home: { sampleSize: 12, goalsForAvg: 1.92, goalsAgainstAvg: 1.08 }, away: { sampleSize: 12, goalsForAvg: 2.25, goalsAgainstAvg: 1.17 } } });
const rehash = clock => { const { contentHash, ...body } = clock; void contentHash; clock.contentHash = crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex"); return clock; };
let checks = 0;
const check = (name, test) => { test(); checks++; };
let original, input;
for (const lane of ["HAD", "HHAD", "NO_ODDS"]) check("entire actual output including receipt hashes replays identically: " + lane, () => {
  const row = fixture();
  if (lane !== "HAD") delete row.odds;
  if (lane === "HHAD") { row.handicapOdds = { odds1: 3.6, oddsX: 3.3, odds2: 1.9 }; row.handicapLine = "-1"; row.handicapOddsSource = "sporttery:HHAD"; }
  const before = encode(row), DateIdentity = globalThis.Date, start = Date.now();
  const output = lane === "NO_ODDS" ? predictionSetWithoutOfficialOdds(row) : predictionSet(row), end = Date.now();
  const clock = output.probabilityModel.executionClock;
  assert.ok(verifyPredictionClock(clock)); assert.ok(clock.events.every(e => e.millis >= start && e.millis <= end));
  assert.equal(globalThis.Date, DateIdentity); assert.equal(encode(row), before);
  // Any uninstrumented wall clock read during replay is a test failure.
  class NoWallDate extends DateIdentity {
    constructor(...args) { if (!args.length) throw new Error("unrecorded-wall-clock-read"); super(...args); }
    static now() { throw new Error("unrecorded-wall-clock-read"); }
  }
  try {
    globalThis.Date = NoWallDate;
    assert.ok(encode(replayPredictionWithClock(row, clock)) === encode(output), "no output fields may be ignored");
    assert.equal(globalThis.Date, NoWallDate, "implementation must never replace the global clock");
  } finally { globalThis.Date = DateIdentity; }
  if (lane === "HAD") { original = output; input = row; }
});
check("missing historical transcript is never synthesized", () => {
  for (const clock of [null, undefined]) assert.throws(() => replayPredictionWithClock(input, clock), /invalid-prediction-clock/);
});
check("tampered clock hash is rejected", () => {
  const clock = structuredClone(original.probabilityModel.executionClock); clock.events[0].millis++;
  assert.throws(() => replayPredictionWithClock(input, clock), /invalid-prediction-clock/);
});
check("even self-rehashed reordered clock operations cannot replay", () => {
  const clock = structuredClone(original.probabilityModel.executionClock);
  clock.events[0].operation = clock.events[0].operation === "iso" ? "millis" : "iso";
  assert.throws(() => replayPredictionWithClock(input, rehash(clock)), /sequence-mismatch/);
});
check("extra unused clock reads are rejected", () => {
  const clock = structuredClone(original.probabilityModel.executionClock); clock.events.push(clock.events[0]);
  assert.throws(() => replayPredictionWithClock(input, rehash(clock)), /unused-prediction-clock-events/);
});
check("truncated transcript cannot fall back to current time", () => {
  const clock = structuredClone(original.probabilityModel.executionClock); clock.events.pop();
  assert.throws(() => replayPredictionWithClock(input, rehash(clock)), /sequence-mismatch/);
});
check("invalid epoch and authority claims are rejected even with matching hash", () => {
  for (const mutate of [c => c.events[0].millis = NaN, c => c.sourceVerified = true, c => c.events[0].millis = -1, c => c.scope = "provider-observed", c => c.extra = true]) {
    const c = structuredClone(original.probabilityModel.executionClock); mutate(c); assert.equal(verifyPredictionClock(rehash(c)), false);
  }
});
check("replay context restores after exception and does not contaminate the next calculation", () => {
  assert.throws(() => executeWithPredictionClock(() => { throw new Error("fixture-error"); }), /fixture-error/);
  const next = predictionSet(input); assert.ok(verifyPredictionClock(next.probabilityModel.executionClock));
  assert.ok(encode(replayPredictionWithClock(input, next.probabilityModel.executionClock)) === encode(next));
});
check("nested live calculations share the outer transcript without global Date override", () => {
  const callback = () => { predictionNowMs(); return executeWithPredictionClock(() => ({ probabilityModel: { generatedAt: predictionNowIso() } })); };
  const output = executeWithPredictionClock(callback); assert.equal(output.probabilityModel.executionClock.events.length, 2);
  assert.deepEqual(executeWithPredictionClock(callback, output.probabilityModel.executionClock), output);
});
check("nested replay cannot override an active execution", () => assert.throws(() => executeWithPredictionClock(() => replayPredictionWithClock(input, original.probabilityModel.executionClock)), /nested-clock-replay-rejected/));
check("async callbacks are rejected before invoking them", () => {
  let called = false;
  assert.throws(() => executeWithPredictionClock(async () => { called = true; }), /synchronous-prediction-required/);
  assert.equal(called, false);
});
check("clock event count is bounded and failure restores the context", () => {
  assert.throws(() => executeWithPredictionClock(() => { for (let n = 0; n < 257; n++) predictionNowMs(); }), /event-limit/);
  assert.ok(Number.isFinite(predictionNowMs()));
});
console.log(JSON.stringify({ ok: true, verifier: "prediction-execution-clock-v1", checks, productionDataTouched: false,
  providerRequests: 0, fullOutputFieldsIgnored: 0, scope: "synchronous local clock transcript replay, not source attestation or model promotion" }, null, 2));
