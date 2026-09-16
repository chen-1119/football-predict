"use strict";

const assert = require("node:assert/strict");
const { storedResultTeamIdentity, derivedTeamId } = require("./storedResultTeamIdentity.cjs");
const { sameEvent } = require("../src/services/matchLifecycle.cjs");

const base = {
  sourceMatchId: "10001",
  kickoffTime: "2026-09-16T11:00:00.000Z",
  eventVersion: "2026-09-16T11:00:00.000Z",
  homeTeamName: "米堡",
  homeTeamId: derivedTeamId("米堡"),
  awayTeamName: "雷克斯",
  awayTeamId: derivedTeamId("雷克斯"),
};

const canonicalNames = {
  ...base,
  homeTeamName: "米德尔斯堡",
  homeTeamId: derivedTeamId("米德尔斯堡"),
  awayTeamName: "雷克斯汉姆",
  awayTeamId: derivedTeamId("雷克斯汉姆"),
};

assert.equal(
  sameEvent(storedResultTeamIdentity(base), storedResultTeamIdentity(canonicalNames)),
  true,
  "display-name-derived IDs for the same immutable event should reconcile",
);

const differentEvent = {
  ...canonicalNames,
  kickoffTime: "2026-09-17T11:00:00.000Z",
  eventVersion: "2026-09-17T11:00:00.000Z",
};
assert.equal(
  sameEvent(storedResultTeamIdentity(base), storedResultTeamIdentity(differentEvent)),
  false,
  "source id reuse at another event time must remain isolated",
);

const realProviderConflict = {
  ...base,
  homeTeamId: "provider-team-1",
};
const otherProviderConflict = {
  ...base,
  homeTeamId: "provider-team-2",
};
assert.equal(
  sameEvent(storedResultTeamIdentity(realProviderConflict), storedResultTeamIdentity(otherProviderConflict)),
  false,
  "real provider-owned team IDs must never be rewritten or merged",
);

const oneProviderIdOneSynthetic = {
  ...canonicalNames,
  homeTeamId: "provider-team-1",
};
assert.equal(
  sameEvent(storedResultTeamIdentity(realProviderConflict), storedResultTeamIdentity(oneProviderIdOneSynthetic)),
  true,
  "same provider ID remains authoritative across display-name changes",
);

for (const wrong of [
  { homeTeamName: "未知球队", homeTeamId: derivedTeamId("未知球队") },
  { homeTeamName: base.awayTeamName, homeTeamId: base.awayTeamId },
  { sourceMatchId: "10002" },
  { kickoffTime: "2026-09-16T11:01:00.000Z" },
]) {
  assert.equal(sameEvent(storedResultTeamIdentity(base), storedResultTeamIdentity({ ...base, ...wrong })), false);
}
console.log(JSON.stringify({ ok: true, tests: 8 }));
