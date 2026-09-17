"use strict";

const assert = require("node:assert/strict");
const { settleEntry, summarize, shanghaiParts, buildLedger } = require("./dailyFeaturedComboLedger.cjs");
const { choose, canPublish } = require("./independentComboSelection.cjs");

const candidate = (id, odds, evidenceScore, market = "HAD", tipCode = "1") => ({
  matchId: `sporttery_${id}`,
  sourceMatchId: id,
  eventVersion: `2026-09-16T${String(10 + Number(id)).padStart(2, "0")}:00:00.000Z`,
  kickoffTime: `2026-09-16T${String(10 + Number(id)).padStart(2, "0")}:00:00.000Z`,
  market,
  tipCode,
  handicapLine: market === "HHAD" ? -1 : 0,
  odds,
  evidenceScore,
  qualityScore: evidenceScore / 100,
  marketDisagreement: 0,
  businessDate: '2026-09-16',
  cutoffTime: `2026-09-16T${String(10 + Number(id)).padStart(2, "0")}:00:00.000Z`,
});

const candidates = [
  candidate("1", 1.62, 82),
  candidate("2", 1.58, 80),
  candidate("3", 2.02, 77),
  candidate("4", 1.70, 75),
];

const two = choose(candidates, 2);
assert.ok(two);
assert.equal(two.size, 2);
assert.ok(two.totalOdds >= 2.5);
assert.equal(two.legs.length, 2);

const three = choose(candidates, 3);
assert.ok(three);
assert.equal(three.size, 3);
assert.ok(three.totalOdds >= 5);
assert.equal(three.legs.length, 3);

assert.equal(choose([candidate("1", 1.2, 90), candidate("2", 1.2, 90)], 2), null);

const entry = {
  id: "combo:test",
  size: 2,
  businessDate: "2026-09-16",
  frozenAt: "2026-09-16T13:00:00.000Z",
  legs: [candidate("1", 1.62, 82), candidate("2", 1.58, 80)],
  settlement: { status: "PENDING", settledAt: null },
};
const history = [
  { id: "sporttery_1", sourceMatchId: "1", eventVersion: entry.legs[0].eventVersion, kickoffTime: entry.legs[0].eventVersion, status: "FINISHED", official: true, resultSource: "sporttery:official-api", scoreHome: 2, scoreAway: 0 },
  { id: "sporttery_2", sourceMatchId: "2", eventVersion: entry.legs[1].eventVersion, kickoffTime: entry.legs[1].eventVersion, status: "FINISHED", official: true, resultSource: "sporttery:official-api", scoreHome: 1, scoreAway: 0 },
];
const settled = settleEntry(entry, history, "2026-09-17T00:00:00.000Z");
assert.equal(settled.settlement.status, "WON");
assert.equal(settled.settlement.results.every((leg) => leg.result === "WON"), true);

const summary = summarize([settled, { ...settled, id: "combo:loss", settlement: { status: "LOST", settledAt: "2026-09-17T00:00:00.000Z" } }], 2);
assert.deepEqual(summary, { published: 2, settled: 2, won: 1, lost: 1, void: 0, hitRate: 0.5 });

const clock = shanghaiParts(Date.parse("2026-09-16T13:05:00.000Z"));
assert.equal(clock.date, "2026-09-16");
assert.equal(clock.hour, 21);

assert.equal(choose([candidate('1', 1.8, 80), candidate('1', 1.8, 80)], 2), null);
assert.equal(choose([{...candidate('1',1.8,80),homeTeamId:'shared'}, {...candidate('2',1.8,80),awayTeamId:'shared'}], 2),null);
assert.equal(settleEntry(entry, history.map((row) => ({...row, resultSource: 'unknown', official: false})), '2026-09-17').settlement.status,'PENDING');
assert.equal(settleEntry(entry, history.map((row) => ({...row, eventVersion: 'different'})), '2026-09-17').settlement.status,'PENDING');
assert.deepEqual(settled.legs,entry.legs,'frozen legs must remain byte-for-byte unchanged');
const voided=settleEntry(entry,[{...history[0],resultDisposition:'VOID',voidSource:'sporttery:official-api',voidReason:'cancelled'}],'2026-09-17');
assert.equal(voided.settlement.status,'VOID'); assert.equal(summarize([voided],2).settled,0);
assert.throws(()=>buildLedger({current:null,history:[],entries:[]}),/Invalid combo/);
const now=Date.parse('2026-09-16T13:05:00Z'), publication={generationId:'g',manifestHash:'h'};
const health={status:{modelRiskStable:true,recommendationReliable:true,dataFresh:true,serviceOk:true}};
const meta={updatedAt:new Date(now).toISOString(),publication};
assert.equal(canPublish(health,meta,publication,now),true);
assert.equal(canPublish({...health,status:{...health.status,modelRiskStable:false,recommendationReliable:false}},meta,publication,now),true);
assert.equal(canPublish(health,meta,{...publication,manifestHash:'other'},now),false);
assert.equal(canPublish(health,meta,publication,now+61*60000),false);
const denied=buildLedger({now,current:[],history,entries:[entry],publishable:false,publication});
assert.equal(denied.entries.length,1); assert.deepEqual(denied.entries[0].legs,entry.legs);
assert.equal(denied.publicPayload.publishable,false);
console.log(JSON.stringify({ ok: true, checks: 23, twoSp: two.totalOdds, threeSp: three.totalOdds }, null, 2));
