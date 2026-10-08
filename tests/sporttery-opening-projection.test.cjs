"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  mapSportteryRow,
  matchesFromSportteryRelaySnapshot,
  projectSportteryCurrentMarkets,
  sportteryCurrentOpeningSummary,
  enrichRawMatchWithPredictionSnapshot,
  mergeMatch,
} = require("../scripts/syncData.cjs");

// Synthetic future fixtures keep the existing real-clock status normalizer
// out of these tests. No stored match, network source or sync main is read/run.
const BUSINESS_DATE = "2027-10-08";
const BEFORE = "2027-10-08T02:59:59.999999999Z";
const OPEN = "2027-10-08T03:00:00.000000000Z";
const AFTER = "2027-10-08T03:00:01.000000000Z";
const URL = "https://webapi.sporttery.cn/gateway/uniform/fb/getMatchDataPageListV1.qry?method=current";
const had = { odds1: 1.91, oddsX: 3.22, odds2: 3.44 };
const hhad = { odds1: 3.2, oddsX: 3.4, odds2: 1.9 };
const raw = {
  matchId: 800001,
  matchNumStr: "周五001",
  businessDate: BUSINESS_DATE,
  matchDate: BUSINESS_DATE,
  matchTime: "20:00:00",
  buyEndTime: `${BUSINESS_DATE} 19:55:00`,
  matchStatus: "Selling",
  homeTeamAllName: "Synthetic Home",
  awayTeamAllName: "Synthetic Away",
  homeTeamCode: "HOM",
  awayTeamCode: "AWY",
  leagueAllName: "Synthetic League",
  leagueId: 999,
  oddsList: [
    { poolCode: "HAD", h: "1.91", d: "3.22", a: "3.44", updateDate: BUSINESS_DATE, updateTime: "11:00:00" },
    { poolCode: "HHAD", h: "3.20", d: "3.40", a: "1.90", goalLine: "-1", updateDate: BUSINESS_DATE, updateTime: "11:00:00" },
  ],
};
const timing = (changes = {}) => ({
  asOf: AFTER,
  requestedAt: OPEN,
  receivedAt: OPEN,
  sourceObservedAt: OPEN,
  sourceCycleId: "synthetic-cycle",
  ...changes,
});
const map = (row = raw, changes = {}, method = "current") => mapSportteryRow(row, method, URL, timing(changes));
const atomFields = [
  "odds", "oddsSource", "oddsPoolCode", "oddsSourceMethod", "oddsObservedAt", "oddsReceivedAt",
  "oddsUpdatedAt", "oddsSourceUrl", "oddsMarketProvenance", "handicapOdds", "handicapLine",
  "handicapOddsSource", "handicapOddsPoolCode", "handicapOddsSourceMethod", "handicapOddsObservedAt",
  "handicapOddsReceivedAt", "handicapOddsUpdatedAt", "handicapOddsSourceUrl", "handicapOddsMarketProvenance",
];
function assertNoNewMarkets(match) {
  for (const key of atomFields) assert.equal(Object.hasOwn(match, key), false, key);
}
function scheduleOf(match) {
  return Object.fromEntries([
    "source", "sourceMethod", "sourceUrl", "sourceMatchId", "matchNo", "businessDate", "matchDate",
    "buyEndTime", "homeTeam", "awayTeam", "homeTeamCode", "awayTeamCode", "leagueName", "leagueCode",
    "kickoffTime", "eventVersion", "status", "sourceObservedAt", "sourceReceivedAt", "sourceCycleId",
  ].map((key) => [key, match[key]]));
}
function snapshot(row = raw, changes = {}) {
  return {
    payload: { sourceCycleId: "synthetic-envelope", sourceCycleKind: "full" },
    entries: [{
      method: "current",
      url: URL,
      requestedAt: OPEN,
      receivedAt: OPEN,
      sourceCycleId: "synthetic-cycle",
      rawSha256: "a".repeat(64),
      rawBytes: 1234,
      collectorAttestation: { version: "synthetic-invalid-signature", signature: "fixture" },
      payload: { value: { matchInfoList: [{ subMatchList: [row] }] } },
      ...changes,
    }],
  };
}
const sha = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

test("one nanosecond before 11:00 retains every schedule identity and omits both complete new market atoms", () => {
  const before = map(raw, { asOf: BEFORE });
  const after = map();
  assertNoNewMarkets(before);
  assert.deepEqual(scheduleOf(before), scheduleOf(after));
  assert.equal(before.status, "SCHEDULED");
  assert.equal(before.kickoffTime, "2027-10-08T20:00:00+08:00");
});

test("the exact 11:00 boundary permits actual post-opening quotes without changing SP or provenance clocks", () => {
  const match = map(raw, { asOf: OPEN });
  assert.deepEqual(match.odds, had);
  assert.deepEqual(match.handicapOdds, hhad);
  assert.equal(match.handicapLine, "-1");
  assert.equal(match.oddsObservedAt, "2027-10-08T03:00:00.000Z");
  assert.equal(match.oddsReceivedAt, OPEN);
});

test("a request started before opening remains blocked even when received and processed after opening", () => {
  assertNoNewMarkets(map(raw, { requestedAt: BEFORE, receivedAt: OPEN, asOf: AFTER }));
});

test("future-business-day prices remain schedule-only even when today's boundary has opened", () => {
  assertNoNewMarkets(map({ ...raw, businessDate: "2027-10-09" }));
});

for (const method of ["current", "calculator", "proxy", "relay:current", "relay:calculator", "cloudflare-current", "all", "history"]) {
  test(`common mapper closes the non-terminal ${method} route without dropping its fixture`, () => {
    const match = map(raw, { asOf: BEFORE }, method);
    assertNoNewMarkets(match);
    assert.equal(match.sourceMethod, method);
    assert.equal(match.sourceMatchId, String(raw.matchId));
    assert.deepEqual(map(raw, {}, method).odds, had);
  });
}

for (const [name, changes] of [
  ["missing observation time", { asOf: null }],
  ["ambiguous observation time", { asOf: "2027-10-08 11:00:00" }],
  ["invalid date", { asOf: "2027-02-30T03:00:01Z" }],
  ["missing request", { requestedAt: null }],
  ["missing response", { receivedAt: null }],
  ["reversed request/response", { requestedAt: AFTER, receivedAt: OPEN }],
  ["response one nanosecond in future", { receivedAt: "2027-10-08T03:00:01.000000001Z" }],
]) {
  test(`${name} fails closed for new SP while keeping ordered teams and source identity`, () => {
    const match = map(raw, changes);
    assertNoNewMarkets(match);
    assert.equal(match.homeTeam, "Synthetic Home");
    assert.equal(match.awayTeam, "Synthetic Away");
    assert.equal(match.sourceMatchId, "800001");
    assert.equal(match.businessDate, BUSINESS_DATE);
  });
}

test("unknown business date fails closed without manufacturing a date or zero SP", () => {
  const match = projectSportteryCurrentMarkets({ ...map(), businessDate: "not-a-date" }, { asOf: AFTER });
  assertNoNewMarkets(match);
  assert.equal(match.businessDate, "not-a-date");
  assert.equal(match.homeTeam, "Synthetic Home");
});

test("relay projection preserves the complete raw endpoint bytes and attestation fields before and after opening", () => {
  const input = snapshot();
  const beforeSha = sha(input);
  const before = matchesFromSportteryRelaySnapshot(input, { asOf: BEFORE });
  assert.equal(before.length, 1);
  assertNoNewMarkets(before[0]);
  const after = matchesFromSportteryRelaySnapshot(input, { asOf: AFTER });
  assert.deepEqual(after[0].odds, had);
  assert.deepEqual(after[0].handicapOdds, hhad);
  assert.equal(sha(input), beforeSha);
  assert.equal(input.entries[0].payload.value.matchInfoList[0].subMatchList[0].oddsList.length, 2);
  assert.equal(input.entries[0].collectorAttestation.signature, "fixture");
});

test("the later upload envelope clock cannot replace missing or pre-opening endpoint acquisition clocks", () => {
  for (const changes of [
    { requestedAt: null, receivedAt: null, fetchedAt: AFTER, updatedAt: AFTER },
    { requestedAt: BEFORE, receivedAt: BEFORE, fetchedAt: AFTER, updatedAt: AFTER },
  ]) {
    const input = snapshot(raw, changes);
    input.payload.updatedAt = AFTER;
    assertNoNewMarkets(matchesFromSportteryRelaySnapshot(input, { asOf: AFTER })[0]);
  }
});

test("the final raw boundary independently checks the exact provenance of both markets after a merge", () => {
  const input = map();
  input.handicapOddsMarketProvenance = {
    ...input.handicapOddsMarketProvenance,
    timing: { ...input.handicapOddsMarketProvenance.timing, requestedAt: BEFORE },
  };
  const projected = projectSportteryCurrentMarkets(input, { asOf: AFTER });
  assert.deepEqual(projected.odds, had);
  assert.equal(Object.hasOwn(projected, "handicapOdds"), false);
  assert.equal(Object.hasOwn(projected, "handicapLine"), false);
  assert.deepEqual(input.handicapOdds, hhad);
  const converse = map();
  converse.oddsMarketProvenance = { ...converse.oddsMarketProvenance, timing: { requestedAt: null, receivedAt: OPEN } };
  const hhadOnly = projectSportteryCurrentMarkets(converse, { asOf: AFTER });
  assert.equal(Object.hasOwn(hhadOnly, "odds"), false);
  assert.deepEqual(hhadOnly.handicapOdds, hhad);
});

test("a secondary endpoint cannot restore prices into the final pre-opening projection", () => {
  const current = map(raw, { asOf: BEFORE });
  const secondary = map(raw, {}, "history");
  const merged = mergeMatch(current, secondary);
  assert.deepEqual(merged.odds, had);
  const final = projectSportteryCurrentMarkets(merged, { asOf: BEFORE });
  assertNoNewMarkets(final);
  assert.equal(final.sourceMatchId, "800001");
});

test("previous-business-day cross-midnight fixture keeps its already eligible quotes before the new day's 11:00", () => {
  const overnight = { ...raw, matchDate: "2027-10-09", matchTime: "08:00:00", buyEndTime: "2027-10-09 07:55:00" };
  const match = map(overnight, {
    asOf: "2027-10-09T00:00:00Z",
    requestedAt: "2027-10-08T10:00:00Z",
    receivedAt: "2027-10-08T10:00:01Z",
    sourceObservedAt: "2027-10-08T10:00:01Z",
  });
  assert.deepEqual(match.odds, had);
  assert.deepEqual(match.handicapOdds, hhad);
  assert.equal(match.businessDate, BUSINESS_DATE);
  assert.equal(match.kickoffTime, "2027-10-09T08:00:00+08:00");
});

test("official final score, result identity and payout remain identical irrespective of the opening clock", () => {
  const result = {
    ...raw, matchStatus: "Finished", sectionsNo999: "2:1",
    officialResultIdentity: { endpoint: "getUniformMatchResultV1", matchId: 800001 },
    officialPayoutSp: { HAD: 1.91, HHAD: 3.4 },
  };
  const before = map(result, { asOf: BEFORE }, "relay:result");
  const after = map(result, {}, "relay:result");
  assert.deepEqual(before, after);
  assert.equal(before.status, "FINISHED");
  assert.equal(before.scoreHome, 2);
  assert.equal(before.scoreAway, 1);
  assert.deepEqual(before.officialPayoutSp, result.officialPayoutSp);
  assert.strictEqual(projectSportteryCurrentMarkets(before, { asOf: null }), before);
});

test("pending status alone cannot authorize pre-opening current prices; result evidence and VOID are retained", () => {
  const pendingRow = { ...raw, matchStatus: "10", officialPayoutSp: { HAD: 1.91 } };
  const pending = map(pendingRow, { requestedAt: BEFORE, receivedAt: BEFORE, asOf: BEFORE });
  assert.equal(pending.status, "PENDING_RESULT");
  assertNoNewMarkets(pending);
  assert.equal(pending.scoreHome, null);
  assert.equal(pending.officialResultIdentity, undefined);
  assert.deepEqual(pending.officialPayoutSp, { HAD: 1.91 });
  assertNoNewMarkets(projectSportteryCurrentMarkets({ ...map(), status: "PENDING_RESULT" }, { asOf: BEFORE }));
  const cancelled = map({ ...raw, matchStatus: "Cancelled", officialPayoutSp: { HAD: 1 } }, { asOf: BEFORE });
  assert.equal(cancelled.resultDisposition, "VOID");
  assert.deepEqual(cancelled.odds, had);
  assert.deepEqual(cancelled.officialPayoutSp, { HAD: 1 });
});

test("stored same-event market atoms and frozen content are preserved without using fresh pre-opening SP", () => {
  const stored = {
    ...map(), odds: { odds1: 1.8, oddsX: 3.3, odds2: 3.6 },
    archivedPreMatchPrediction: { syntheticSeal: "immutable-only" },
    predictionMeta: { decisionId: "frozen-fixture", lockedAt: OPEN },
    predictions: [{ marketType: "BEST", tipCode: "1", synthetic: true }],
  };
  const beforeSha = sha(stored);
  const fresh = map(raw, { asOf: BEFORE });
  assertNoNewMarkets(fresh);
  const enriched = enrichRawMatchWithPredictionSnapshot(fresh, new Map([["800001", stored]]), []);
  assert.deepEqual(enriched.odds, stored.odds);
  assert.deepEqual(enriched.handicapOdds, stored.handicapOdds);
  assert.equal(enriched.oddsReceivedAt, stored.oddsReceivedAt);
  assert.equal(enriched.oddsSourceMethod, stored.oddsSourceMethod);
  assert.equal(sha(stored), beforeSha);
  assert.equal(Object.hasOwn(fresh, "odds"), false);
});

test("inheriting old HAD cannot attach its naked old handicap line to a distinct fresh HHAD atom", () => {
  const stored = { ...map(), handicapLine: "-2" };
  for (const field of atomFields.filter((field) => field.startsWith("handicapOdds"))) delete stored[field];
  const fresh = map();
  fresh.oddsMarketProvenance = {
    ...fresh.oddsMarketProvenance,
    timing: { requestedAt: BEFORE, receivedAt: OPEN },
  };
  const projected = projectSportteryCurrentMarkets(fresh, { asOf: AFTER });
  assert.equal(Object.hasOwn(projected, "odds"), false);
  assert.deepEqual(projected.handicapOdds, hhad);
  const enriched = enrichRawMatchWithPredictionSnapshot(projected, new Map([["800001", stored]]), []);
  assert.deepEqual(enriched.odds, stored.odds);
  assert.deepEqual(enriched.handicapOdds, fresh.handicapOdds);
  assert.equal(enriched.handicapLine, "-1");
  assert.strictEqual(enriched.handicapOddsMarketProvenance, fresh.handicapOddsMarketProvenance);
  assert.equal(enriched.handicapOddsSourceMethod, fresh.handicapOddsSourceMethod);
  assert.equal(stored.handicapLine, "-2");
});

test("retaining an existing HHAD atom also retains its own line, source and exact provenance", () => {
  const stored = map({
    ...raw,
    oddsList: raw.oddsList.map((pool) => pool.poolCode === "HHAD" ? { ...pool, goalLine: "-2" } : pool),
  });
  const fresh = map(raw, { asOf: BEFORE });
  const enriched = enrichRawMatchWithPredictionSnapshot(fresh, new Map([["800001", stored]]), []);
  assert.equal(enriched.handicapLine, "-2");
  assert.strictEqual(enriched.handicapOddsMarketProvenance, stored.handicapOddsMarketProvenance);
  assert.equal(enriched.handicapOddsSourceMethod, stored.handicapOddsSourceMethod);
  assert.deepEqual(enriched.handicapOdds, stored.handicapOdds);
});

test("a reused provider ID cannot inherit the old event's stored quote after schedule-only projection", () => {
  const existing = map({ ...raw, matchDate: "2027-10-07", matchTime: "20:00:00", buyEndTime: "2027-10-07 19:55:00" });
  const fresh = map(raw, { asOf: BEFORE });
  const enriched = enrichRawMatchWithPredictionSnapshot(fresh, new Map([["800001", existing]]), []);
  assertNoNewMarkets(enriched);
  assert.equal(enriched.eventVersion, fresh.eventVersion);
});

test("supplemental source projection is unchanged by the Sporttery-specific boundary", () => {
  const supplemental = { ...map(), source: "five-hundred", oddsSource: "500.com" };
  assert.strictEqual(projectSportteryCurrentMarkets(supplemental, { asOf: BEFORE }), supplemental);
});

test("intentional pre-opening projection has an explicit waiting diagnostic without claiming source freshness", () => {
  const summary = sportteryCurrentOpeningSummary([map(raw, { asOf: BEFORE })], { asOf: BEFORE });
  assert.deepEqual(summary, {
    version: "sporttery-current-opening-projection-v1",
    evaluatedAt: BEFORE,
    policyWaiting: true,
    waitingMatches: 1,
    openingReachedMatches: 0,
    invalidClockMatches: 0,
  });
  for (const field of ["sourceFresh", "sourceVerified", "publicationEligible", "stale", "freshnessTime"]) {
    assert.equal(Object.hasOwn(summary, field), false, field);
  }
});

test("diagnostic keeps current-day waiting, previous-business-day opening and result/VOID counts separate", () => {
  const previousDay = { ...map(), businessDate: "2027-10-07" };
  const terminal = { ...map(), status: "FINISHED" };
  const cancelled = { ...map(), resultDisposition: "VOID" };
  const supplemental = { ...map(), source: "five-hundred" };
  const summary = sportteryCurrentOpeningSummary([map(), previousDay, terminal, cancelled, supplemental], { asOf: BEFORE });
  assert.equal(summary.waitingMatches, 1);
  assert.equal(summary.openingReachedMatches, 1);
  assert.equal(summary.invalidClockMatches, 0);
});

test("unknown clocks are diagnostic failures rather than a false intentional policy wait", () => {
  const summary = sportteryCurrentOpeningSummary([map(), { ...map(), businessDate: "invalid" }], { asOf: null });
  assert.equal(summary.policyWaiting, false);
  assert.equal(summary.waitingMatches, 0);
  assert.equal(summary.openingReachedMatches, 0);
  assert.equal(summary.invalidClockMatches, 2);
});
