"use strict";

const assert = require("node:assert/strict");
const {
  buildResultProvenance,
  reconcileMatchLifecycle,
  resolveMatchLifecycle,
} = require("../src/services/matchLifecycle.cjs");
const {
  matchesFromSportteryRelaySnapshot,
} = require("./syncData.cjs");
const {
  resultObservationForMatch,
} = require("./asOfResultTimeline.cjs");
const {
  buildResultMergeSignal,
} = require("./sync500Details.cjs");

const officialUrl = "https://webapi.sporttery.cn/gateway/uniform/fb/getMatchDataPageListV1.qry?method=result&pageSize=80";
const kickoffTime = "2026-07-16T01:00:00+08:00";
const kickoffUtc = "2026-07-15T17:00:00.000Z";
const fetchedAt = "2026-07-15T19:08:09.123Z";

const relaySnapshot = {
  payload: { capturedAt: "2026-07-15T19:08:10.000Z" },
  summary: { capturedAt: "2026-07-15T19:08:10.000Z" },
  entries: [{
    id: "method:result:1",
    method: "result",
    url: officialUrl,
    fetchedAt,
    receivedAt: fetchedAt,
    ok: true,
    payload: {
      value: {
        matchInfoList: [{
          subMatchList: [{
            matchId: "observation-1001",
            matchDate: "2026-07-16",
            matchTime: "01:00",
            businessDate: "2026-07-15",
            matchStatus: "11",
            matchStatusName: "Finished",
            homeTeamAllName: "Home",
            awayTeamAllName: "Away",
            leagueAllName: "Audit League",
            sectionsNo999: "2:1",
          }],
        }],
      },
    },
  }],
};

const rows = matchesFromSportteryRelaySnapshot(relaySnapshot);
assert.equal(rows.length, 1);
const officialRaw = rows[0];
assert.equal(officialRaw.status, "FINISHED");
assert.equal(officialRaw.resultObservedAt, fetchedAt);
assert.equal(officialRaw.resultObservationSource, "sporttery-relay-endpoint-received-at");
assert.equal(officialRaw.resultSourceUpdatedAt, null);
assert.equal(Object.hasOwn(officialRaw, "resultSourceUpdatedAt"), true);
assert.equal(officialRaw.resultObservationFallback, false);
assert.equal(officialRaw.eventVersion, kickoffTime);

const earlyLiveRelaySnapshot = {
  entries: [{
    id: "method:current:early-live",
    method: "current",
    url: officialUrl,
    fetchedAt: "2026-07-15T16:45:00.000Z",
    receivedAt: "2026-07-15T16:45:00.000Z",
    ok: true,
    payload: {
      value: {
        matchInfoList: [{
          subMatchList: [{
            matchId: "early-live-1002",
            matchDate: "2099-07-16",
            matchTime: "01:00",
            businessDate: "2099-07-15",
            matchStatus: "4",
            matchStatusName: "进行中",
            homeTeamAllName: "Early Home",
            awayTeamAllName: "Early Away",
            leagueAllName: "Clock Audit League",
          }],
        }],
      },
    },
  }],
};
const earlyLiveRows = matchesFromSportteryRelaySnapshot(earlyLiveRelaySnapshot);
assert.equal(earlyLiveRows.length, 1);
assert.equal(earlyLiveRows[0].status, "LIVE");
assert.equal(earlyLiveRows[0].firstInPlayObservedAt, "2026-07-15T16:45:00.000Z");

const official = resolveMatchLifecycle(officialRaw, { now: fetchedAt });
assert.equal(official.resultProvenance.version, "result-provenance-v2");
assert.equal(official.resultProvenance.observedAt, fetchedAt);
assert.equal(official.resultProvenance.observationSource, "sporttery-relay-endpoint-received-at");
assert.equal(official.resultProvenance.sourceUpdatedAt, null);
assert.equal(official.resultProvenance.sourceUpdatedAtAvailable, false);
assert.equal(official.resultProvenance.eventVersion, kickoffUtc);
assert.equal(official.resultProvenance.promotionEligible, true);

const earlyLiveSnapshot = {
  ...officialRaw,
  status: "LIVE",
  sourceStatus: "LIVE",
  scoreHome: undefined,
  scoreAway: undefined,
  resultSource: undefined,
  resultUpdatedAt: undefined,
  resultObservedAt: undefined,
  resultObservationSource: undefined,
  resultObservationFallback: undefined,
  resultSourceUpdatedAt: undefined,
  resultProvenance: undefined,
  firstInPlayObservedAt: "2026-07-15T16:45:00.000Z",
  inPlayObservationSource: "sporttery-relay-endpoint-received-at",
};
const earlyLiveFinal = reconcileMatchLifecycle(earlyLiveSnapshot, official);
assert.equal(earlyLiveFinal.status, "FINISHED");
assert.equal(earlyLiveFinal.resultProvenance.firstInPlayObservedAt, "2026-07-15T16:45:00.000Z");
assert.equal(
  earlyLiveFinal.resultProvenance.inPlayObservationSource,
  "sporttery-relay-endpoint-received-at",
);
assert.equal(earlyLiveFinal.resultProvenance.promotionEligible, true);

const legacyAttributed = resolveMatchLifecycle({
  ...officialRaw,
  resultObservedAt: undefined,
  resultObservationSource: undefined,
  resultObservationFallback: undefined,
  resultProvenance: {
    provider: "sporttery",
    official: true,
    trusted: true,
    source: "sporttery",
    sourceMethod: "result",
    sourceUrl: officialUrl,
    sourceMatchId: officialRaw.sourceMatchId,
    sourceStatus: "FINISHED",
    scoreHome: officialRaw.scoreHome,
    scoreAway: officialRaw.scoreAway,
    kickoffTime: kickoffUtc,
    eventVersion: kickoffUtc,
    observedAt: fetchedAt,
  },
}, { now: fetchedAt });
assert.equal(legacyAttributed.resultProvenance.observedAt, fetchedAt);
assert.equal(legacyAttributed.resultProvenance.observationSource, "sporttery-trusted-provenance-observed-at");
assert.equal(legacyAttributed.resultProvenance.observationSourceInferred, true);
assert.equal(legacyAttributed.resultProvenance.observationSourceDerivation, "trusted-legacy-sporttery-provenance");
assert.equal(legacyAttributed.resultProvenance.eventVersionConsistent, true);
assert.equal(legacyAttributed.resultProvenance.promotionEligible, true);
assert.deepEqual(resultObservationForMatch(legacyAttributed), {
  observedMs: Date.parse(fetchedAt),
  observedAt: fetchedAt,
  source: "sporttery-trusted-provenance-observed-at",
  sourceInferred: true,
  fallback: false,
  promotionEligible: true,
});

const missingTrustedFlag = resolveMatchLifecycle({
  ...officialRaw,
  resultObservedAt: undefined,
  resultObservationSource: undefined,
  resultObservationFallback: undefined,
  resultProvenance: {
    ...legacyAttributed.resultProvenance,
    trusted: undefined,
    observationSource: undefined,
    observationSourceInferred: undefined,
    observationSourceDerivation: undefined,
  },
}, { now: fetchedAt });
assert.equal(missingTrustedFlag.resultProvenance.observedAt, null,
  "legacy observation clocks require an explicit trusted=true provenance marker");
assert.equal(missingTrustedFlag.resultProvenance.observationSource, null);
assert.equal(missingTrustedFlag.resultProvenance.resultObservationFallback, true);
assert.equal(missingTrustedFlag.resultProvenance.promotionEligible, false);

const mismatchedEventVersion = resolveMatchLifecycle({
  ...legacyAttributed,
  eventVersion: "2026-07-15T18:00:00.000Z",
});
assert.equal(mismatchedEventVersion.resultProvenance.eventVersionConsistent, false);
assert.equal(mismatchedEventVersion.resultProvenance.resultObservationFallback, true);
assert.equal(mismatchedEventVersion.resultProvenance.promotionEligible, false);
assert.equal(resultObservationForMatch(mismatchedEventVersion).source, "declared-result-observation-fallback");

const rebuiltLater = resolveMatchLifecycle({
  ...official,
  capturedAt: "2026-07-16T09:00:00.000Z",
  updatedAt: "2026-07-16T09:00:00.000Z",
});
assert.equal(rebuiltLater.resultProvenance.observedAt, fetchedAt);
assert.equal(rebuiltLater.resultProvenance.observationSource, "sporttery-relay-endpoint-received-at");

const legacy = resolveMatchLifecycle({
  source: "sporttery",
  sourceMethod: "result",
  sourceUrl: officialUrl,
  sourceMatchId: "observation-1001",
  kickoffTime,
  status: "FINISHED",
  scoreHome: 2,
  scoreAway: 1,
  capturedAt: "2026-07-16T09:00:00.000Z",
  updatedAt: "2026-07-16T09:00:00.000Z",
  resultSource: "sporttery:official-api",
});
assert.equal(legacy.status, "FINISHED");
assert.equal(legacy.resultProvenance.observedAt, null, "generic sync clocks must not become result observation clocks");
assert.equal(legacy.resultProvenance.observationSource, null);
assert.equal(legacy.resultProvenance.sourceUpdatedAt, null);
assert.equal(legacy.resultProvenance.resultObservationFallback, true);
assert.equal(legacy.resultProvenance.promotionEligible, false);
assert.deepEqual(resultObservationForMatch(legacy), {
  observedMs: null,
  observedAt: null,
  source: "declared-result-observation-fallback",
  fallback: true,
  promotionEligible: false,
});

const upgraded = reconcileMatchLifecycle(legacy, official);
assert.equal(upgraded.status, "FINISHED");
assert.equal(upgraded.resultProvenance.observedAt, fetchedAt);
assert.equal(upgraded.resultProvenance.resultObservationFallback, false);
assert.equal(upgraded.resultProvenance.promotionEligible, true);

const fallbackBorrowingOfficialFixture = resolveMatchLifecycle({
  source: "sporttery",
  sourceMethod: "result",
  sourceUrl: officialUrl,
  sourceMatchId: "fallback-500-1",
  kickoffTime,
  status: "FINISHED",
  scoreHome: 3,
  scoreAway: 2,
  resultSource: "500.com:jczq-result",
  resultObservedAt: fetchedAt,
  resultObservationSource: "500.com-response-received-at",
  resultObservationFallback: true,
});
assert.equal(fallbackBorrowingOfficialFixture.status, "PENDING_RESULT");
assert.equal(fallbackBorrowingOfficialFixture.resultProvenance, null);
assert.equal(fallbackBorrowingOfficialFixture.scoreHome, undefined);

const fiveHundredSignal = buildResultMergeSignal({
  sourceMatchId: "fallback-500-2",
  kickoffTime,
  buyEndTime: kickoffTime,
  resultSource: "500.com:jczq-result",
  resultUpdatedAt: fetchedAt,
  scoreHome: 1,
  scoreAway: 1,
}, null, fetchedAt);
const fiveHundredResult = fiveHundredSignal.fiveHundred.result;
assert.equal(fiveHundredResult.observationSource, "500.com-response-received-at");
assert.equal(fiveHundredResult.sourceUpdatedAt, null);
assert.equal(fiveHundredResult.resultObservationFallback, true);
assert.equal(fiveHundredResult.eventVersion, kickoffTime);
assert.equal(fiveHundredResult.sourceObservedAt, fetchedAt);

const invalidChronology = buildResultProvenance({
  source: "sporttery",
  sourceUrl: officialUrl,
  sourceMatchId: "invalid-clock-1",
  kickoffTime,
  status: "FINISHED",
  scoreHome: 0,
  scoreAway: 0,
  resultSource: "sporttery:official-api",
  resultObservedAt: "2026-07-15T16:59:59.000Z",
  resultObservationSource: "sporttery-relay-endpoint-fetched-at",
  resultObservationFallback: false,
});
assert.equal(invalidChronology.resultObservationFallback, true);
assert.equal(invalidChronology.promotionEligible, false);

console.log(JSON.stringify({
  ok: true,
  verifier: "result-observation-provenance",
  assertions: 55,
  official: {
    observedAt: official.resultProvenance.observedAt,
    observationSource: official.resultProvenance.observationSource,
    sourceUpdatedAt: official.resultProvenance.sourceUpdatedAt,
    eventVersion: official.resultProvenance.eventVersion,
    promotionEligible: official.resultProvenance.promotionEligible,
  },
  legacy: {
    observedAt: legacy.resultProvenance.observedAt,
    fallback: legacy.resultProvenance.resultObservationFallback,
    promotionEligible: legacy.resultProvenance.promotionEligible,
  },
  fiveHundredFallback: {
    status: fallbackBorrowingOfficialFixture.status,
    observationSource: fiveHundredResult.observationSource,
    fallback: fiveHundredResult.resultObservationFallback,
  },
}, null, 2));
