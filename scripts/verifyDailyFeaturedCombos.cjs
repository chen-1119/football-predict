"use strict";

const assert = require("node:assert/strict");
const {
  buildDailyFeaturedCombos,
  TWO_LEG_MIN_SP,
  THREE_LEG_MIN_SP,
} = require("./buildDailyFeaturedCombos.cjs");

const now = Date.parse("2026-09-16T21:05:00+08:00");
const businessDate = "2026-09-16";

const match = (id, sp, tipCode, evidenceScore, kickoffHour = 23) => ({
  id: `sporttery_${id}`,
  sourceMatchId: id,
  businessDate,
  kickoffTime: `2026-09-16T${String(kickoffHour).padStart(2, "0")}:00:00+08:00`,
  eventVersion: `2026-09-16T${String(kickoffHour).padStart(2, "0")}:00:00+08:00`,
  status: "SCHEDULED",
  homeTeamName: `H${id}`,
  awayTeamName: `A${id}`,
  oddsSource: "sporttery:HAD",
  odds: tipCode === "1"
    ? { odds1: sp, oddsX: 3.2, odds2: 4.2 }
    : tipCode === "X"
      ? { odds1: 2.2, oddsX: sp, odds2: 3.8 }
      : { odds1: 2.1, oddsX: 3.1, odds2: sp },
  predictions: [{
    marketType: "BEST",
    oddsPoolCode: "HAD",
    tipCode,
    tipLabel: { zh: tipCode, en: tipCode },
    odds: sp,
    trustScore: evidenceScore,
    recommendationAction: "recommend",
    recommendationTier: "main",
    multiFactorEvidence: {
      version: "multi-factor-market-evidence-v2",
      eligible: true,
      market: "HAD",
      code: tipCode,
      handicapLine: 0,
      odds: sp,
      evidenceScore,
      blockers: [],
    },
    riskTags: [],
  }],
});

const current = [
  match("101", 1.60, "1", 78),
  match("102", 1.70, "1", 75),
  match("103", 2.00, "2", 73),
  match("104", 1.45, "1", 64),
];

const first = buildDailyFeaturedCombos({ nowMs: now, currentMatches: current, historyMatches: [] });
assert.equal(first.publicPayload.today.state, "published");
assert.equal(first.publicPayload.today.twoLeg.status, "published");
assert.equal(first.publicPayload.today.threeLeg.status, "published");
assert.equal(first.publicPayload.today.twoLeg.legs.length, 2);
assert.equal(first.publicPayload.today.threeLeg.legs.length, 3);
assert.ok(first.publicPayload.today.twoLeg.combinedSp >= TWO_LEG_MIN_SP);
assert.ok(first.publicPayload.today.threeLeg.combinedSp >= THREE_LEG_MIN_SP);
const frozenTwo = JSON.stringify(first.publicPayload.today.twoLeg.legs);
const frozenThree = JSON.stringify(first.publicPayload.today.threeLeg.legs);

const changedCurrent = current.map((row) => ({
  ...row,
  odds: { ...row.odds, odds1: Number(row.odds.odds1 || 0) + 0.2 },
}));
const second = buildDailyFeaturedCombos({
  nowMs: now + 10 * 60_000,
  currentMatches: changedCurrent,
  historyMatches: [],
  ledger: first.ledger,
});
assert.equal(JSON.stringify(second.publicPayload.today.twoLeg.legs), frozenTwo, "published 2x1 must remain frozen");
assert.equal(JSON.stringify(second.publicPayload.today.threeLeg.legs), frozenThree, "published 3x1 must remain frozen");

const finished = current.map((row) => ({
  ...row,
  status: "FINISHED",
  scoreHome: row.predictions[0].tipCode === "2" ? 0 : 2,
  scoreAway: row.predictions[0].tipCode === "2" ? 1 : 0,
}));
const settled = buildDailyFeaturedCombos({
  nowMs: Date.parse("2026-09-17T12:00:00+08:00"),
  currentMatches: [],
  historyMatches: finished,
  ledger: second.ledger,
});
const priorDay = settled.ledger.rows.find((row) => row.businessDate === businessDate);
assert.equal(priorDay.twoLeg.settlement.status, "WON");
assert.equal(priorDay.threeLeg.settlement.status, "WON");
assert.equal(settled.publicPayload.stats.twoLeg.won, 1);
assert.equal(settled.publicPayload.stats.threeLeg.won, 1);
assert.equal(settled.publicPayload.stats.twoLeg.hitRate, 100);
assert.equal(settled.publicPayload.stats.threeLeg.hitRate, 100);

const insufficient = buildDailyFeaturedCombos({
  nowMs: Date.parse("2026-09-18T22:30:00+08:00"),
  currentMatches: [],
  historyMatches: [],
});
assert.equal(insufficient.publicPayload.today.state, "no-qualified-combo");
assert.equal(insufficient.publicPayload.today.twoLeg.status, "insufficient-qualified-pool");
assert.equal(insufficient.publicPayload.today.threeLeg.status, "insufficient-qualified-pool");

process.stdout.write(`${JSON.stringify({
  ok: true,
  twoLegMinSp: TWO_LEG_MIN_SP,
  threeLegMinSp: THREE_LEG_MIN_SP,
  tests: 16,
}, null, 2)}\n`);
